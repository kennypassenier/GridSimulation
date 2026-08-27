# Services in Node.js

Zes services, allemaal zonder dependencies. De achtergrond bij die keuze staat in Energiebronnen.md. Dit document gaat over wat elke service doet, hoe de controller beslist, en hoe de images op de workers geraken.

De echte bron is repo/services/. De bestanden zijn kort, lees ze ernaast.

## Een pod is een generator.

De ontwerpregel voor alles: een pod is een generator met een vaste capaciteit in MW, meegegeven via een environment variabele. Het totale aanbod van een bron is het aantal ready pods maal die capaciteit. Daardoor betekent "replicas schalen" iets fysiek. Dat is ook de zin waarmee ik de verdediging open.

- diesel, 50 MW per pod, 0 tot 12 pods, ready na ongeveer 2 seconden, geschaald door de controller
- nucleair, 600 MW, 0 of 1 pod, ready na 60 seconden, geschaald door de controller
- wind, 40 MW per pod, 2 tot 8 pods, ready na ongeveer 2 seconden, geschaald door CronJobs

Die getallen zijn gekozen voor de demo en ze houden elkaar in evenwicht. Als ik er een verander moet ik de rest nakijken. Met een basisvraag van 100 MW en een piek van 500 MW, en een marge van 10 procent:

- Slechtste geval is diesel alleen bij weinig wind. Restvraag wordt 550 min 80 is 470 MW, dat zijn 10 dieselpods. Dat past onder het plafond van 12 met wat ruimte over, en dat is precies wat criterium 1 nodig heeft tijdens die 60 seconden opstarten.
- De kerncentrale dekt met 600 MW elke demo piek in haar eentje, dus na de overname zakt diesel helemaal naar 0. Dat is het duidelijkste beeld van "neemt de belasting over".
- Bij veel wind heeft dezelfde piek maar 5 dieselpods nodig in plaats van 10. Dat verschil ziet iedereen op het scherm.

De vraag accepteert 0 tot 1000 MW met opzet. Boven de ontwerpcapaciteit van ongeveer 680 MW komt het net bewust tekort. Dat is load shedding en dat doet een echt net ook.

Wind is geen vast getal. Elke turbine rapporteert zijn eigen actuele opbrengst, die tussen 50 en 100 procent van de 40 MW wandelt op een sinus met een eigen willekeurige fase. De controller vraagt elke windpod naar zijn werkelijke productie in plaats van de nominale waarde aan te nemen. Daardoor is "dynamisch rekening houden met de windproductie" letterlijk waar en beweegt de grafiek zichtbaar tussen de demo stappen door.

## Drie routes per service.

Elke service heeft "/healthz" voor liveness, "/ready" voor readiness en "/status" met JSON voor de controller.

Liveness en readiness moeten gescheiden blijven. De kerncentrale is tijdens het opstarten gezond maar nog niet inzetbaar. Wie die twee door elkaar haalt laat Kubernetes de pod elke 60 seconden opnieuw doodmaken, eeuwig.

Elke service vangt SIGTERM zelf op:

```js
process.on('SIGTERM', () => process.exit(0));
```

Node draait als PID 1 in een container en PID 1 negeert standaard signalen. Zonder die regel blijft elke stoppende pod de volle 30 seconden hangen tot SIGKILL, en dan lijkt de diesel afbouw kapot omdat vertrekkende pods zichzelf nog als Ready melden.

## De 60 seconden zitten in de reactor, niet in de controller.

De nuclear-plant geeft HTTP 503 op "/ready" tot "SPINUP_MS" voorbij is. De readinessProbe in het manifest bevraagt dat elke 2 seconden, dus Kubernetes houdt de pod uit de Service endpoints en uit de berekening van de controller tot hij echt stroom kan leveren.

Die ene beslissing maakt criterium 1 eerlijk. Er zit nergens een timer in de controller, de overname wordt gestuurd door een waargenomen toestandsverandering en niet door een stopwatch. De 60 seconden bestaan op precies een plek, dus er kan niets uit de pas lopen. En het is een echt Kubernetes mechanisme dat echt werk doet, wat het vak nu net is.

## grid-controller.

Twee bestanden. "k8s.js" is een zelfgeschreven Kubernetes client over de https module van Node, die zich aanmeldt met de ServiceAccount van de pod. Vier operaties, meer niet: pods opsommen op label, de scale subresource van een deployment lezen en patchen, en de ConfigMap "grid-demand" lezen en schrijven.

Het token wordt bij elke aanvraag opnieuw van schijf gelezen. K3s geeft tokens met een beperkte geldigheidsduur, dus wie dat token bij het opstarten cachet krijgt een uur later 401 fouten. Dat merk je nooit tijdens een demo van tien minuten, wel de ochtend erna.

"server.js" orchestreert het geheel, een tick per 5 seconden:

```
wind      = som van de gemelde opbrengst van elke ready windpod
residual  = max(0, ceil(demand * 1.1) - wind)
nuclear   = 1 als residual >= 150 MW, 0 als residual == 0
dieselWant= ceil(max(0, residual - readyNuclearMw) / 50), max 12
dieselNext= omhoog -> meteen dieselWant
            omlaag -> max(dieselWant, huidig - 2)
```

Alles wat ik moet kunnen verdedigen zit in die vijf regels.

De overname heeft geen apart geval nodig. Een reactor die niet ready is levert 0 MW, dus dieselWant blijft hoog. Op het moment dat readiness omslaat valt de term "residual - readyNuclearMw" weg en bouwt diesel af. Een expressie, twee fasen.

Het schalen is asymmetrisch. Omhoog in een keer, omlaag maximaal 2 pods per tick. Dat is "gecontroleerd afgebouwd" uit het projectvoorstel, en het voorkomt een dip in het aanbod.

Het plafond van 12 dieselpods is bewuste schaarste. Zonder plafond is de kerncentrale nooit nodig en heeft criterium 1 niets te tonen. Het houdt ook het slechtste geval, alle pods op een worker, binnen de capaciteit van die worker via rekenwerk in plaats van geluk.

De regelkring is idempotent. Elke tick herberekent het doel uit de waargenomen toestand, dus gemiste ticks, dubbele ticks en herstarts zijn allemaal onschadelijk. Gevraagd naar het patroon: dit is dezelfde observe, diff en act lus die de controllers van Kubernetes zelf gebruiken.

De vraagwaarde staat in een ConfigMap en niet in het geheugen. "main()" leest ze voor de eerste tick, dus een controller die met zijn worker meesterft komt terug op dezelfde instelwaarde. Dat is het volledige verhaal over state management, in drie regels, en het is live bewezen tijdens de chaos test.

## dashboard.

Een klein bestand dat drie dingen doet: statische bestanden serveren, de API van de controller proxyen, en de chaos knop afhandelen. De frontend is gemaakt met Bootstrap.

Aanmelden gaat met een gedeeld wachtwoord dat met "crypto.timingSafeEqual" vergeleken wordt en daarna een met HMAC ondertekende sessiecookie oplevert. Stateless van opzet, dus beide replicas aanvaarden dezelfde sessie zonder gedeelde opslag. De HMAC sleutel komt uit het wachtwoord zelf, dus er is geen tweede geheim om te beheren.

De panelen worden elke 2 seconden bijgewerkt: vraag tegenover totaal aanbod met een rode markering bij tekort, een grafiek van ongeveer vijf minuten met de vraag als lijn en het aanbod als gestapelde vlakken per bron, de opstartindicator van de reactor, de pods per worker in twee vaste kolommen met een VM status uit de Proxmox API, een gebeurtenislogboek, en het chaos paneel.

Die grafiek is het overtuigendste beeld van de hele demo. De dieselblok die krimpt terwijl het nucleaire blok stijgt is de overname.

Elke fetch heeft een expliciete timeout nodig met "AbortSignal.timeout(4000)". Vlak na een kill kan de verbinding van de browser vastzitten op een dode pod en eeuwig blijven hangen. De eerste versie bevroor op oude data en toonde twee draaiende VM's terwijl er een uit stond.

Pods mogen niet nep verdwijnen. Als een VM sterft blijft de Kubernetes API die pods nog ongeveer 30 seconden melden. Het dashboard toont de waarheid van Proxmox, de VM wordt binnen 3 seconden rood, naast de waarheid van Kubernetes, de pods blijven doorstreept staan tot ze geevicteerd zijn. Dat gat zien dichtgaan is de les. Het verbergen zou het mechanisme verbergen waarop ik beoordeeld word.

## Dockerfiles.

Een vorm voor alle services, zonder installatiestap want er zijn geen dependencies.

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY . .
USER node
EXPOSE 3000
CMD ["node", "server.js"]
```

Alpine voor de grootte, ongeveer 48 MB per image. Sneller starten betekent sneller herplannen en dat is demo relevant. "USER node" omdat root in een container het eerste is dat iemand aanwijst. Geen "npm ci" omdat de services enkel de standaardbibliotheek van Node gebruiken.

De wind-scaler is anders en nog kleiner. Alpine met curl, en een script van vijf regels dat de scale subresource van de wind Deployment patcht met zijn eigen ServiceAccount token.

## Images verdelen zonder registry.

Bouwen gebeurt op de server VM, die door de taint toch geen workloads draait. Daarna gaan de images rechtstreeks in de containerd van elke worker.

```bash
sudo docker build -t gridsim/<service>:v2 <service>
for w in 10.10.10.21 10.10.10.22; do
  sudo docker save gridsim/<service>:v2 | ssh kenny@$w "sudo k3s ctr -n k8s.io images import -"
done
```

Daarvoor is een SSH sleutel van de server naar beide workers nodig. Samen met "imagePullPolicy: IfNotPresent" heeft de demo nul externe afhankelijkheden voor images. Geen registry login, geen rate limits, en geen internet nodig wanneer een pod midden in de chaos test herplaatst wordt.

De keerzijde bijt wel. Met een vaste tag moet ik eerst naar beide workers importeren en pas daarna "kubectl rollout restart" doen, nooit omgekeerd. En een worker die uit stond tijdens een ronde komt terug met oude images. Opnieuw importeren en herstarten.

## Wat er kan misgaan.

**De controller logt 403 in het cluster.** Dat is RBAC. Nakijken met "kubectl auth can-i patch deployments/diesel-generator --subresource=scale -n grid --as=system:serviceaccount:grid:grid-controller".

**De controller werkt een uur en geeft dan 401.** Het ServiceAccount token is bij het opstarten gecachet. Per aanvraag opnieuw lezen.

**De readiness probe werkt lokaal maar niet in het cluster.** De probe gaat naar het pod IP, dus de server moet op alle interfaces luisteren. "http.createServer().listen(3000)" doet dat vanzelf, niet "verbeteren" naar 127.0.0.1.

**Alles schaalt behalve op nul.** Dat is de val met "spec.replicas" in de scale subresource, zie build-log.md.

**Pods doen er 30 seconden over om te verdwijnen tijdens de afbouw.** Ontbrekende SIGTERM handler.

**Het image werkt lokaal en crasht op het cluster met "exec format error".** Ofwel gebouwd voor de verkeerde architectuur, ofwel is de containerd store beschadigd door een harde kill tijdens het uitpakken van images.
