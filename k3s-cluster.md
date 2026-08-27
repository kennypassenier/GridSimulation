# K3s cluster

Uitgangspunt zijn de drie VM's uit proxmox-setup.md. Resultaat is een cluster met een control plane waar niets op mag draaien, twee workers, kubectl vanaf mijn desktop, en een gemeten bewijs dat een pod van een uitgezette worker binnen een minuut terug is.

## Server installeren.

SSH naar 10.10.10.20:

```bash
curl -sfL https://get.k3s.io | sh -s - server \
  --node-taint node-role.kubernetes.io/control-plane=true:NoSchedule \
  --tls-san 10.10.10.20 \
  --write-kubeconfig-mode 644
```

De taint is de belangrijkste vlag van het hele project. K3s plant standaard wel workloads op de server, anders dan een volledige Kubernetes distributie. Met deze taint blijft de applicatie van het control plane af, en daardoor is "de docent kan enkel workload VM's afsluiten" een eigenschap van het systeem in plaats van een belofte. De systeempods van k3s die op de server moeten draaien tolereren de taint zelf.

"--tls-san" zet het IP in het certificaat van de API server, anders geeft kubectl vanaf mijn desktop TLS fouten.

Het join token staat in:

```bash
sudo cat /var/lib/rancher/k3s/server/node-token
```

## Workers joinen.

Op elke worker:

```bash
curl -sfL https://get.k3s.io | K3S_URL=https://10.10.10.20:6443 \
  K3S_TOKEN=<token> sh -
```

## kubectl vanaf mijn desktop.

Kopieer "/etc/rancher/k3s/k3s.yaml" van de server en vervang in dat bestand "127.0.0.1" door "10.10.10.20". Die kopie staat hier als kubeconfig-gridsim.yaml.

```bash
KUBECONFIG=~/GridSimulation/kubeconfig-gridsim.yaml kubectl get nodes -o wide
```

Verwacht: drie nodes Ready, k3s v1.36.3+k3s1, containerd 2.3.2, Ubuntu 24.04.4. Staat een worker op NotReady, geef het dertig seconden, flannel heeft even nodig. De taint op de server controleer je met "kubectl describe node k3s-server | grep Taint".

Dat certificaat in de kubeconfig geeft cluster-admin rechten. Behandelen als een wachtwoord, niet als documentatie.

## Snellere detectie van een dode node.

Dit is de meest demo kritische instelling van het project. Standaard wordt een pod op een dode node pas na 5 minuten geevicteerd, door de impliciete toleration van 300 seconden op de taint "unreachable". Die helft los ik op met "tolerationSeconds: 10" in elke Deployment. De andere helft is hoe lang het duurt voor de node uberhaupt als onbereikbaar gemarkeerd wordt, standaard ongeveer 40 seconden.

Op de server in "/etc/rancher/k3s/config.yaml":

```yaml
kube-controller-manager-arg:
  - node-monitor-grace-period=20s
```

Daarna "sudo systemctl restart k3s". Het budget voor herstel wordt dan ongeveer 20 seconden om NotReady te markeren, 10 seconden toleration, plus de starttijd van de pod. Samen 35 tot 45 seconden.

Niet lager zetten. Onder de 15 seconden kan een worker die even hapert door een trage schijf of een backup snapshot zijn pods onterecht kwijtraken. Een cluster dat flapt is erger dan een demo die iets trager is.

## Chaos baseline test.

Deze test doe ik bewust voor ik ook maar een regel applicatiecode schrijf. Als de chaos test later raar doet, weet ik dan of ik mijn app of mijn cluster moet debuggen.

Een canary deployment met 4 replicas van "rancher/mirrored-pause:3.6", met dezelfde tolerations van 10 seconden en dezelfde spread constraint die later elke workload krijgt. De vier pods moeten 2/2 over de workers staan en geen enkele op de server. Staat er toch een op k3s-server, dan is de taint niet toegepast en klopt de rest van het project niet meer.

Meten doe ik met twee terminals. In de ene:

```bash
kubectl get pods -l app=canary -o wide -w
```

In de andere "qm stop 202" op de Proxmox host, of de Stop knop in de UI als "docent@pve" zodat de repetitie hetzelfde pad gebruikt als het examen. Stopwatch starten bij de stop.

Wat je ziet gebeuren, in volgorde: node NotReady na 12 tot 20 seconden, de pods erop gaan naar Terminating, vervangers verschijnen op de overlevende worker, en alle vier draaien daar na 24 tot 29 seconden. Op mijn hardware was dat 24 seconden bij worker-1 en 29 seconden bij worker-2. Minstens drie keer draaien en beide workers als slachtoffer nemen.

**Nooit een node killen die nog images aan het uitpakken is.** Bij mij heeft dat de containerd store van de worker verminkt, alle containers kwamen daarna crashend terug. Het hele verhaal en de reparatie staan in build-log.md.

Daarna "qm start 202". De node komt terug, maar de bestaande pods verhuizen niet terug. Kubernetes verplaatst draaiende pods niet om de spreiding te herstellen, dat gebeurt pas bij de volgende schaalactie. Goed om te weten, want de verdeling ziet er na een chaos test scheef uit en dat is een waarschijnlijke examenvraag.

## Wat er kan misgaan.

**Pods blijven eeuwig op Terminating staan terwijl er wel vervangers komen.** Dat is correct gedrag. De API server kan de dood van die pods niet bevestigen zolang de node weg is. Het is boekhouding, geen vastgelopen workload. Tijdens de demo uitleggen in plaats van het te laten lijken op een fout.

**Er gebeurt vijf minuten lang niets.** Dan staan de tolerations niet op de pods. Ze horen in de pod template en niet bovenaan de Deployment, en een verkeerd ingesprongen YAML blok faalt hier stil. Controleren met "kubectl get pod <p> -o yaml | grep -A4 toleration".

**Node flapt tussen NotReady en Ready zonder dat ik iets kil.** Grace period te laag, schijf te traag, of de worker komt geheugen tekort waardoor de kubelet geknepen wordt. Eerst de grace period terug richting 40 seconden, daarna pas verder zoeken met "journalctl -u k3s-agent" op de worker.

**Vervangers blijven Pending.** De overlevende worker heeft geen plaats. In deze fase betekent dat de VM te klein is. Later betekent hetzelfde symptoom meestal dat de requests van de containers te hoog staan voor een wereld met een enkele worker. De chaos test moet per ontwerp binnen de capaciteit van een worker passen.
