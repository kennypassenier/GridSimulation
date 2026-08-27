# Build log

Wat er echt gebeurd is tijdens het bouwen, met de fouten erbij. Waar dit document en de setup documenten elkaar tegenspreken, wint dit document. 

## Fase 1, de VM's.

Template 9000 op basis van de Ubuntu 24.04 cloud image, opslag local-lvm, guest agent aan, seriele console, cloud-init op ide2 en het snippet "local:snippets/k3s-base.yaml" voor de guest agent en swapoff.

Daarna de drie VM's gecloned:

- 201 k3s-server, 2 cores, 2048 MiB RAM, 20,5 GB schijf
- 202 k3s-worker-1, 2 cores, 2560 MiB RAM, 31,5 GB schijf
- 203 k3s-worker-2, 2 cores, 2560 MiB RAM, 31,5 GB schijf

### Eindtoestand.

Alle drie op "cloud-init status: done", swap op 0, guest agent actief, juiste schijfgroottes, SSH als kenny naar 10.10.10.20, 21 en 22.

## Fase 2, het cluster.

K3s v1.36.3+k3s1, geinstalleerd met het script van get.k3s.io.

De server krijgt drie vlaggen mee:

- de control plane taint, zodat mijn workloads van de server blijven
- "--tls-san 10.10.10.20" zet dat IP in het certificaat van de API server. Zonder die vlag klaagt kubectl vanaf mijn desktop dat het certificaat niet bij het adres past.
- "--write-kubeconfig-mode 644", want anders is "k3s.yaml" enkel leesbaar voor root. Dat bestand is de bron van kubeconfig-gridsim.yaml.

De workers draaien hetzelfde installatiescript, maar met "K3S_URL" en "K3S_TOKEN" erbij. Die twee variabelen maken er een agent van in plaats van een server. De URL zegt waar de server staat, het token bewijst dat de node mag joinen.

Daarna op de server in "/etc/rancher/k3s/config.yaml":

```yaml
kube-controller-manager-arg:
  - node-monitor-grace-period=20s
```

Dat is hoe lang de server op een hartslag wacht voor hij een node NotReady verklaart. Standaard 40 seconden, ik halveer dat. Samen met de toleration van 10 seconden in elke Deployment is dat mijn volledige herstelbudget.

Gecontroleerd met "kubectl get nodes" en "kubectl describe node k3s-server | grep Taint". Drie nodes Ready, taint staat waar hij moet staan.

## Fase 3, de chaos baseline.

Deze test doe ik bewust voor er ook maar een regel applicatiecode bestaat. Doet de chaos test later raar, dan weet ik of ik mijn app of mijn cluster moet debuggen.

Canary met 4 keer pause:3.6, tolerations van 10 seconden, spread met maxSkew 1. Kwam 2 om 2 op de workers terecht en niets op de server. Gemeten met een poller van 1 seconde, "qm stop" als kill:

- worker-1: NotReady na 12 seconden, alle vier draaiend op de overlevende na **24 seconden**
- worker-2: NotReady na 19 seconden, alle vier draaiend na **29 seconden**

### Probleem 3, image corruptie na een harde kill.

Dit is de grootste van de reeks. Ik heb de eerste kill gedaan ongeveer een minuut na het aanmaken van het cluster, terwijl worker-1 nog systeemimages aan het uitpakken was. Na "qm start" crashte elke container op die worker, traefik, svclb en canary, met exit 255. Een herstart van de agent hielp niet. Een nette reboot hielp ook niet. "crictl logs" gaf de oorzaak: "exec /entrypoint.sh: exec format error". De harde poweroff had half geschreven image layers in de content store van containerd verminkt.

De journaling van ext4 heeft het bestandssysteem gered. De uitgepakte layers van containerd zijn niet crash safe, en dat is precies de laag waarvan iedereen aanneemt dat het wel goed zit.

Wat werkte:

```bash
systemctl stop k3s-agent
rm -rf /var/lib/rancher/k3s/agent/containerd
systemctl start k3s-agent
```

De worker haalt daarna alles opnieuw op, ongeveer een minuut, en daarna de vastzittende pods geforceerd verwijderen.

Drie regels die ik hieruit haal voor de demo:

- nooit een node killen die nog images aan het ophalen is, dus eerst laten bezinken voor ik de knop uit handen geef
- komt een node terug en crasht alles met exit 255, dan is de containerd wipe een oplossing van 90 seconden
- de eerste meting was hierdoor vervuild. Die heb ik opnieuw gedaan en de ongeldige run laat ik in dit log staan voor de eerlijkheid.

## Fase 4 tot 12, code en deploy.

Zes services in repo/services/, geen enkele dependency. De controller praat rechtstreeks met de Kubernetes API over HTTPS, met het ServiceAccount token dat in de pod gemonteerd staat. Dat token wordt per aanvraag opnieuw van schijf gelezen.

Bouwen gebeurt met Docker op de server VM, die door de taint toch niets draait. Verdelen gaat zonder registry:

```bash
docker save gridsim/<service>:v2 | ssh worker "k3s ctr -n k8s.io images import -"
```

Daarvoor heb ik een SSH sleutel van de server naar beide workers aangemaakt. Geen registry betekent geen internetafhankelijkheid op het moment dat een pod midden in de chaos test herplaatst wordt.

Wat er uitgerold is:

- namespace "grid"
- RBAC met minimale rechten. De controller mag enkel aan de scale van diesel en nucleair, plus configmaps lezen en schrijven en pods opsommen. De wind-scaler mag enkel aan de scale van wind-farm.
- de drie bronnen, de controller, en twee dashboards op NodePort 30080
- wind CronJobs op Europe/Brussels. Om 6 en 15 uur naar 8 turbines, om 11 en 21 uur terug naar 2.

### Probleem 4, /scale geeft een leeg object bij nul replicas.

Bij de eerste piek van 500 MW startte de kerncentrale wel maar schaalde diesel nooit. In het beslissingslog stond "diesel:undefined->NaN". De Scale subresource serialiseert "spec.replicas" met "omitempty" van Go, dus bij 0 replicas ontbreekt het veld volledig. Dat werd undefined en elke berekening erna werd stil NaN. Opgelost met ".spec.replicas || 0" in getReplicas.

### Probleem 5, PID 1 negeert SIGTERM.

Na die oplossing waren de beslissingen correct maar bleef het aanbod 30 seconden nahangen. Node draait als PID 1 in de container en PID 1 negeert SIGTERM standaard, dus elke beeindigde pod bleef Ready tot de SIGKILL.

In twee lagen opgelost. In elke service "process.on('SIGTERM', () => process.exit(0))", en de controller telt pods met een deletionTimestamp niet meer mee als aanbod. Een vertrekkende pod levert geen stroom.

### Probleem 6, bitnami/kubectl verdwenen van Docker Hub.

De wind CronJob gaf "docker.io/bitnami/kubectl:1.31: not found", want Bitnami heeft de gratis tags in 2025 opgeruimd. Vervangen door een zelfgebouwde wind-scaler van 5 MB, alpine met curl die de scale subresource patcht met zijn eigen token. Achteraf beter, want nu zijn er nul externe pulls tijdens de demo en blijft de vastgezette RBAC gelden.

### Observatie 7, NodePort hangt vlak na een kill.

Een nieuwe verbinding naar de NodePort in de eerste 20 seconden na een dode worker kan naar het endpoint van de dode pod gestuurd worden en blijft dan hangen. Altijd korte HTTP timeouts gebruiken. De endpoints worden opgeruimd zodra de node NotReady wordt, dus het venster is begrensd door de detectietijd.

## Gemeten resultaten.

### Criterium 1, gefaseerde overname. Vraag van 100 naar 500, wind 2 pods.

- basis: wind 80, diesel 50, nucleair 0, totaal 130
- +10 s: diesel op 500 MW met 10 pods, piek volledig door diesel gedekt
- +62 s: nog aan het opstarten
- +68 s: nucleair kritisch met 600 MW, diesel begint af te bouwen
- +88 s: overname compleet, diesel op 0

### Criterium 2, A/B met wind. Zelfde piek van 500 MW.

- 2 windpods, 80 MW: diesel piekt op 10 pods en 500 MW, daarna 0
- 8 windpods, 320 MW: diesel piekt op 5 pods en 250 MW, daarna 0

### Criterium 3, chaos. Worker-2 gekild met de dashboard knop, met de controller en de kerncentrale erop en volle belasting van 500 MW.

- 0 s: harde stop via de chaos knop
- +19 s: worker-2 NotReady
- +32 s: controller herplaatst op worker-1, vraag van 500 teruggelezen uit de ConfigMap
- +42 s: dieselvloot herbouwd, 500 MW dekt de vraag op de overlevende worker
- +90 s: nucleair opnieuw kritisch, met een eerlijke nieuwe opstarttijd van 60 seconden
- +115 s: afbouw klaar, net stabiel op een enkele worker

Verder geverifieerd: worker-1 killen terwijl worker-2 al plat lag geeft een weigering met HTTP 409. Herstel via de Power on knop, de node was na ongeveer 50 seconden terug Ready.

## Toegang en gegevens.

- Dashboard op http://10.10.10.20:30080, elk node IP werkt.
- Wachtwoorden en het PVE token in SECRETS-local-only.txt, niet in de repo. De kopie voor het cluster zit in de Kubernetes Secret "dashboard-secrets".
- Proxmox voor de docent met "docent@pve", realm "Proxmox VE authentication server", ziet enkel VM 202 en 203.
- kubectl met KUBECONFIG naar kubeconfig-gridsim.yaml.
- Terug naar de basis: vraag op 0, 25 seconden wachten tot de kerncentrale uit is, dan vraag op 100. Windpods kunnen na een chaos test op een node samenklonteren, want spreiding verplaatst draaiende pods niet. Een rollout restart van wind-farm of een willekeurige schaalactie verdeelt ze opnieuw.

## Sessie 2, UI en extra chaos scenario's.

### Probleem 8, dashboard bleef op oude data hangen.

Ik heb worker-1 hard gekild en de UI bleef beide VM's als draaiend tonen. De oorzaak was dat fetch in de browser geen standaard timeout heeft, en de verbinding van dat tabblad zat via conntrack vastgepind aan de dashboard pod die met de worker meestierf. De pollende lus bleef eeuwig hangen op een dode TCP verbinding.

Opgelost met "AbortSignal.timeout" op elke fetch, lussen die zichzelf herstellen, en een banner met "cluster onbereikbaar, opnieuw proberen" in plaats van stilzwijgend oude data. De kill zelf had trouwens perfect gewerkt, alle pods stonden al op worker-2.

### Wijzigingen aan de UI.

- Twee vaste kolommen per worker die altijd getoond worden, met alle grid pods. Controller en dashboard in het grijs, de bronnen in kleur. Een dode VM krijgt een rode rand en een statusbadge die elke 3 seconden uit de Proxmox API komt. De pods blijven doorstreept staan als laatst bekende toestand tot Kubernetes ze evicteert. Ze meteen laten verdwijnen zou liegen zijn, want de API gelooft echt nog dat ze bestaan.
- Een gebeurtenislogboek met het nieuwste bovenaan: veranderingen in de vraag, aantallen diesel en wind, toestandswissels van de reactor, herplaatsing van de controller, VM's die komen en gaan, en het begin en einde van een tekort.
- Schuifregelaar van 0 tot 1000 MW. Boven ongeveer 680 is het tekort opzettelijk.

### Wind realistischer gemaakt.

CronJobs kunnen niet fijner dan een minuut en moeten replicas ook niet zitten heen en weer te duwen. De CronJobs bepalen daarom nog steeds het regime, dus het aantal turbines, terwijl elke turbine zijn eigen opbrengst tussen 50 en 100 procent van 40 MW laat wandelen op een sinus met een eigen fase. De controller leest de echte opbrengst uit "/status" van elke windpod met een timeout van 1,5 seconde, met de nominale 40 MW als terugval.

Daardoor is "dynamisch rekening houden met de windproductie" letterlijk waar en beweegt de grafiek bij elke poll. Zichtbaar neveneffect dat het tonen waard is: het dieseldoel volgt de windvlagen live tussen 450 en 550 MW.

### Extra chaos scenario's, allebei live geverifieerd.

Test A, stabiel net met de reactor kritisch, en dan de node gekild waar de controller en de kerncentrale op stonden, met de vraag rond 1000. Het gat in "/state" duurde ongeveer 30 seconden voor de controller herplaatst was, diesel zat op het maximum van 600 MW na 39 seconden, en de reactor was kritisch op de overlevende na 92 seconden. De vraag boven de capaciteit gaf het bedoelde tekort tijdens het opstarten.

Test B, de node gekild waar de kerncentrale op stond terwijl die aan het opstarten was, met vraag 500 en 10 dieselpods verdeeld 5 om 5. Na 24 seconden waren de 5 diesels van het slachtoffer geevicteerd, aanbod zakte naar 305 MW en er was ongeveer 12 seconden tekort. Na 33 seconden was de reactor herplaatst en begon het opstarten eerlijk opnieuw, en na 36 seconden waren de vervangende diesels ready en was de vraag weer gedekt. De controller koos er 11 omdat de wind net in een dal zat.

Twee valkuilen die ik in deze sessie echt heb geraakt. Een "kubectl apply" van 10-sources.yaml midden in een test zette diesel en nucleair terug op 0 replicas, waarna de controller binnen een tick alles herbouwde uit de ConfigMap. En de valkuil met dezelfde image tag: worker-1 stond uit tijdens een distributieronde en draaide na de herstart even oude images, tot opnieuw importeren plus een rollout restart het rechttrok.

## Bewust niet gedaan.

- De Cloudflare Tunnel en Access route. De chaos paden die er wel zijn: de dashboard knop als hoofdweg, "docent@pve" in de Proxmox UI als reserve, en "qm stop" op de host als laatste redmiddel.
- De kapotte nachtelijke ZFS replicatie op de host repareren. Staat los van dit project.
