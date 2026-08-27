# Projectvoorstel: High availability elektriciteitsnetsimulator
## Specifiek 

Ik ontwerp, containeriseer en orchestreer een elektriciteitsnetsimulatie met behulp van microservices om mijn competenties in Server & Cloud Technologies aan te tonen. Ik bouw hiervoor een lokale Proxmox cluster op met verschillende virtuele machines. Hierop installeer en beheer ik een K3s Kubernetes cluster dat zal fungeren als het brein van de operatie. Ik ontwikkel het stroomnet zelf met drie op Docker gebaseerde stroombronnen: snelle dieselgeneratoren met autoscaling, een trage nucleaire centrale met opstartvertraging en een windmolenpark waarbij ik windenergie simuleer via tijdgestuurde cronjobs.

## Meetbaar 

### Ik demonstreer mijn kennis met succes door tijdens de evaluatie aan de volgende criteria te voldoen:

**Gefaseerde autoscaling**: Ik simuleer live een stroompiek door de vraag te verhogen, waarbij ik aantoon dat snelle containers de gevraagde belasting helemaal opvangen. Ik pas de configuratie zo toe dat na exact 60 seconden de trage nucleaire container de belasting overneemt, waarna de snelle containers weer gecontroleerd afgebouwd worden.

**Tijdgestuurde orchestratie**: Ik schaal de windenergie succesvol op en af via Kubernetes cronjobs. Ik toon hierbij aan dat het systeem, afhankelijk van wanneer de stroompiek gesimuleerd wordt, dynamisch rekening houdt met de stroom die het windmolenpark genereert.

**Chaos engineering**: Ik geef tijdens de live demo de controle over de VM's aan de docent. Ik demonstreer dat, wanneer de docent een harde shutdown van één van de Proxmox virtuele machines uitvoert, Kubernetes dit probleem automatisch oplost door dynamisch en tijdig nieuwe containers aan te maken in de overgebleven virtuele machines.

**Bereikbaarheid**: Ik configureer een veilige Cloudflare Tunnel, waardoor ik het project vanuit mijn lokaal thuisnetwerk toch veilig en zonder problemen van buitenaf toegankelijk maak voor de demonstratie.

## Acceptabel 
Ik bewijs met dit project een fundamenteel inzicht in het gebruik van servers waarop containers op een dynamische manier worden beheerd en opgeschaald. Ik pas complexe architectuurkeuzes toe rondom state management, failover-mechanismen, veilige netwerkroutering en schaalbaarheid.

## Realistisch 
Ik haal dit doel door de theorie te vertalen naar een strak afgebakende Proof of Concept. Hoewel ik de stroombronnen als microservices ontwikkel, leg ik de meeste nadruk voornamelijk op de architectuur en orchestratie van deze services. Ik rol de omgeving uit op een dedicated Proxmox server om een professionele enterprise-omgeving accuraat na te bootsen en onvoorspelbare externe cloud-kosten te beperken. Ik creëer met behulp van declaratieve configuraties en K3s een gecontroleerde testomgeving, waarmee ik op een betrouwbare manier de infrastructuur kan demonstreren.

## Tijdgebonden 
Ik dien dit projectvoorstel in voor vrijdag 19 juni 2026 om 16u30. Ik rond de technische implementatie van het cluster af, zodat ik de live demonstratie succesvol kan presenteren tijdens de examenperiode in de tweede zittijd.