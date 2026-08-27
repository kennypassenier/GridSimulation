# Proxmox setup

## De host en de drie VM's.

Proxmox VE 9.2.4 op 10.10.5.250, 12 cores en 31 GiB RAM. 8,3 GiB RAM effectief vrij. De planning ging uit van 4 GiB per VM en dat paste niet. Het is 2048 MiB voor de server geworden en 2560 MiB per worker. Gemeten is dat ruim genoeg, ook in het slechtste geval waarbij alle pods op één worker draaien.

- 201 "k3s-server", 10.10.10.20, 2 cores, 2048 MiB, 20,5 G
- 202 "k3s-worker-1", 10.10.10.21, 2 cores, 2560 MiB, 31,5 G
- 203 "k3s-worker-2", 10.10.10.22, 2 cores, 2560 MiB, 31,5 G

De bridge "vmbr0" is VLAN aware, dus elke VM heeft "tag=10" nodig. Gateway en DNS zijn 10.10.10.1, dat is de OPNsense VM op diezelfde host. Zonder die tag komt het verkeer nergens. De bestaande LXC's gebruiken hetzelfde patroon.

## Template aanmaken. Eenmalig.

Ubuntu drie keer installeren is verloren tijd. Met een template zijn de nodes identiek en is een kapotte VM opnieuw opbouwen twee commando's in plaats van een avond.

Eerst het content type "snippets" aanzetten op storage "local". Let op, "pvesm set" vervangt de hele lijst. Eerst lezen wat er staat en dan alles opnieuw opgeven, anders verlies je stilletjes een type. Op deze host stond "import" er ook bij.

```bash
grep -A2 '^dir: local$' /etc/pve/storage.cfg
pvesm set local --content backup,vztmpl,iso,import,snippets
```

Daarna de template zelf:

```bash
wget https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img

qm create 9000 --name ubuntu-2404-tmpl --memory 2048 --cores 2 \
  --net0 virtio,bridge=vmbr0 --scsihw virtio-scsi-pci --agent enabled=1

qm set 9000 --scsi0 local-lvm:0,import-from=$(pwd)/noble-server-cloudimg-amd64.img
qm set 9000 --ide2 local-lvm:cloudinit
qm set 9000 --boot order=scsi0 --serial0 socket --vga serial0
qm template 9000
```

"--agent enabled=1" zet het kanaal naar de qemu-guest-agent open. Zonder dat kan Proxmox een nette shutdown niet onderscheiden van een harde stop en blijft het IP veld in de UI leeg. Het pakket zelf moet nog in de gast geïnstalleerd worden, dat doet cloud-init hieronder.

"--serial0 socket --vga serial0" is nodig omdat cloud images een seriele console gebruiken. Zonder deze regel blijft het consolevenster zwart en denk je een uur lang dat de VM niet boot.

## Cloud-init.

Per VM instellen, hier de server als voorbeeld:

```bash
qm set 201 --ciuser kenny --sshkeys /root/gridsim-sshkey.pub \
  --net0 virtio,bridge=vmbr0,tag=10 \
  --ipconfig0 ip=10.10.10.20/24,gw=10.10.10.1 \
  --nameserver 10.10.10.1
```

Enkel SSH keys, geen wachtwoorden. De publieke sleutel moet vooraf op de host staan zodat "--sshkeys" hem kan lezen.

Daarnaast een eigen snippet in "/var/lib/vz/snippets/k3s-base.yaml" voor de guest agent en om swap uit te zetten:

```yaml
#cloud-config
package_update: true
packages:
  - qemu-guest-agent
runcmd:
  - systemctl enable --now qemu-guest-agent
  - swapoff -a
  - sed -i '/ swap / s/^/#/' /etc/fstab
```

Aankoppelen met "qm set <vmid> --cicustom vendor=local:snippets/k3s-base.yaml".

Swap uitzetten is niet optioneel. De kubelet weigert te starten met actieve swap, tenzij je "failSwapBehavior" expliciet configureert. En een node die swapt geeft precies de onvoorspelbare vertraging die een demo met verwachtte timingen onbruikbaar maakt.

## De drie VM's klonen.

```bash
qm clone 9000 201 --name k3s-server --full
qm clone 9000 202 --name k3s-worker-1 --full
qm clone 9000 203 --name k3s-worker-2 --full

qm resize 201 scsi0 +17G
qm resize 202 scsi0 +28G
qm resize 203 scsi0 +28G

qm set 201 --memory 2048 --cores 2 --onboot 1
qm set 202 --memory 2560 --cores 2 --onboot 1
qm set 203 --memory 2560 --cores 2 --onboot 1

qm start 201 && qm start 202 && qm start 203
```

"--onboot 1" telt mee. Na een harde kill van de docent start ik de worker live opnieuw op, en als de host zelf ooit herstart moet de hele stack vanzelf terugkomen.

Netwerk en cloud-init instellen VOOR de eerste boot, en de VM daarna met rust laten tot "cloud-init status" op "done" staat. Wie dat achteraf nog aanpast moet de VM stoppen midden in de eerste boot, en dat onderbreekt apt en dpkg. Dat is bij mij één keer misgegaan, zie build-log.md.

## Resource pool: dit is de rechtenbegrenzing.

```bash
pvesh create /pools --poolid gridsim-chaos
pvesh set /pools/gridsim-chaos --vms 202,203
```

De rol zegt wat iemand mag, de pool zegt op welke resources. Zonder deze twee regels bestaat "/pool/gridsim-chaos" niet en falen alle "acl modify"-commando's hieronder. Enkel de twee workers zitten erin, dus VM 201 (k3s-server) is onbereikbaar en zelfs onzichtbaar voor iedereen met rechten op deze pool.

## User met rechten voor power management van enkel onze worker VM's.

```bash
pveum role add ChaosRole -privs "VM.PowerMgmt VM.Audit"
pveum group add chaos-testers
pveum user add docent@pve --groups chaos-testers --comment "Examinator - alleen power mgmt workers"
pveum passwd docent@pve
pveum acl modify /pool/gridsim-chaos --groups chaos-testers --roles ChaosRole
```

"VM.Audit" zit erbij zodat de docent de VM's kan zien. Zou anders een lege boom tonen

"VM.PowerMgmt" start, stop, shutdown, reset, suspend en resume. Niet mogelijk om bv enkel stop te tonen.

**Inloggen met gebruikersnaam "docent"** (niet "docent@pve") 
realm:"Proxmox VE authentication server". 

Realm is de sterkste beveiliging in deze opzet. Het account bestaat alleen in "/etc/pve/user.cfg", niet in "/etc/passwd". Geen Linux account betekent geen shell, geen SSH, geen console op de hypervisor.

## Token zodat we geen wachtwoord moeten gebruiken in de code.

```bash
pveum user add chaosbot@pve
pveum acl modify /pool/gridsim-chaos --users chaosbot@pve --roles ChaosRole
pveum user token add chaosbot@pve chaosbtn --privsep 0
```

Een aparte gebruiker, zodat de credentials van de docent en die van het dashboard onafhankelijk van elkaar zijn.

"docent@pve" krijgt zijn rechten
via "--groups", "chaosbot@pve" rechtstreeks via "--users".

"--privsep 0" laat het token de rechten van "chaosbot@pve" erven. 
"--privsep 1" start het token op nul rechten en heeft het een eigen Access Control List nodig.
Dat is buiten de scope van deze demo.

Er staat geen "--expire" op, dus het token verloopt nooit. Bewuste keuze voor de demo. Na afloop intrekken:

```bash
pveum user token remove chaosbot@pve chaosbtn
```

## Controle

```bash
pveum user list
pveum acl list
pvesh get /pools/gridsim-chaos
```

`pveum acl list` toont bij de docent de GROEP "chaos-testers" en niet zijn gebruikersnaam. Zoeken op "docent" lijkt dan leeg terug te komen.
Dat is geen fout maar het gevolg van de groepstoekenning.

Zelf nakijken voor de demo: inloggen als "docent@pve" in een privevenster en controleren dat hij enkel VM 202 en 203 ziet, dat Stop werkt, en dat Remove, Console en de hostinstellingen niet verschijnen. VM 201 mag niet in de lijst staan.

## Wat er kan misgaan.

**VM krijgt geen IP.** Bijna altijd de cloud-init drive die niet aanhangt (ide2), of instellingen die na de eerste boot zijn aangepast. Netwerkconfiguratie van cloud-init geldt alleen bij de eerste boot. Opnieuw klonen is sneller dan repareren, en dat is meteen waarvoor die template dient.

**"import-from" geeft een padfout.** Dat vraagt een absoluut pad en de image moet leesbaar zijn voor root.

**De host komt RAM tekort.** Neem het eerst van de server VM. Het control plane draait licht in deze opzet, terwijl de workers de volledige belasting van een dode buur moeten opvangen tijdens de chaos test. ZFS ARC geeft geheugen terug onder druk, dus "free -h" ziet er krapper uit dan het is.

**Content lijst van de storage stilletjes ingekort.** Als ISO uploads of container templates niet meer werken na het aanzetten van snippets, dan is er een type verdwenen met "pvesm set". Opnieuw lezen en de volledige lijst herstellen.

**De docent ziet niets na het inloggen.** Twee klassiekers. De ACL staat op de groep maar de user zit niet in die groep, controleer met "pveum user list". Of hij logt in met realm PAM in plaats van PVE.

**Het token werkt plots niet meer.** Zonder "--privsep 0" heeft het token geen enkel recht tot je een aparte Access Control List op het token zelf zet. De user werkt dan wel en het token geeft 401. Bij 403 fouten van de chaos knop is dit het eerste om na te kijken.
