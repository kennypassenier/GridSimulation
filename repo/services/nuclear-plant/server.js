// Kerncentrale: de trage, zware basislastbron. Eén pod, 600 MW.
// Dit bestand is de kern van de gefaseerde autoscaling.
//
// De beslissing die alles draagt: DE 60 SECONDEN ZITTEN HIER, NIET IN DE
// CONTROLLER. Deze pod meldt zichzelf via /ready 60 seconden lang als niet
// gereed (503). De readinessProbe pollt dat elke 2 seconden, dus Kubernetes
// houdt de pod buiten de capaciteit. De controller ziet "0 MW nucleair" en
// houdt diesel hoog; zodra de probe omslaat ziet hij 600 MW en bouwt diesel af.
// De overname is dus gebeurtenisgestuurd: nergens telt een timer af.
//
// Overwogen alternatieven en waarom ze afvielen:
// - Een setTimeout van 60 s in de controller: dan staat de opstarttijd op twee
//   plaatsen en kan die uit elkaar lopen. En het zou een geprogrammeerde
//   vertraging zijn in plaats van een Kubernetes-mechanisme. Doet de centrale
//   er 70 s over, dan duurt de overname nu gewoon 70 s - de controller wacht
//   op de centrale, niet op de klok.
// - initialDelaySeconds: 60 op de probe: werkt, maar dan weet de pod zelf niet
//   dat hij opstart en kan /status geen voortgang rapporteren voor het dashboard.
// - Een initContainer die 60 s slaapt: dan is de pod pas laat zichtbaar,
//   terwijl we juist willen tonen dat de centrale al bestaat en opstart
//   terwijl diesel de last draagt.

const http = require("http");

// 600 MW: genoeg om elke demopiek alleen te dekken, zodat diesel na de
// overname helemaal naar nul afbouwt.
const CAPACITY_MW = Number(process.env.CAPACITY_MW || 600);

// De opstarttijd staat als env var in het manifest: tijdens het ontwikkelen
// zet je hem op 5000, in het manifest staat 60000.
const SPINUP_MS = Number(process.env.SPINUP_MS || 60000);

// Per pod: wordt de node hard afgesloten, dan start de vervangende pod zijn
// opstart eerlijk opnieuw - een reactor die uitvalt is niet meteen weer kritiek.
const startedAt = Date.now();

const ready = () => Date.now() - startedAt >= SPINUP_MS;

// Opstartvoortgang in procenten, puur voor het dashboard: zonder indicator
// staart iedereen een minuut naar een stilstaand scherm. Math.min houdt de
// waarde op 100 als de pod al langer draait.
const spinupPct = () => Math.min(100, Math.round(((Date.now() - startedAt) / SPINUP_MS) * 100));

http.createServer((req, res) => {
    // Liveness: het proces leeft, vanaf seconde één. Een opstartende reactor
    // is niet kapot - zou dit /ready zijn, dan herstart Kubernetes hem eeuwig.
    if(req.url === "/health"){
        res.writeHead(200);
        return res.end("ok");
    }
    // Readiness: 503 tot de reactor kritiek is. Dit is het mechanisme achter
    // de gefaseerde overname. In 10-sources.yaml staat failureThreshold: 45
    // zodat 60 seconden 503 antwoorden geen waarschuwingen in de events zet.
    if(req.url === "/ready"){
        res.writeHead(ready() ? 200 : 503);
        return res.end();
    }
    if(req.url === "/status"){
        res.writeHead(200, {
            "Content-Type": "application/json"
        });
        return res.end(JSON.stringify({
            source: "nuclear",
            unit: process.env.HOSTNAME || "local",
            // Nul tijdens het opstarten: een reactor die nog niet kritiek is
            // telt voor niets mee. Dit maakt de overname mogelijk.
            capacityMw: ready() ? CAPACITY_MW : 0,
            // CRITICAL in de kerntechnische betekenis: de kettingreactie is
            // zichzelf onderhoudend en de centrale levert vermogen.
            state: ready() ? "CRITICAL" : "SPINNING_UP",
            spinupPct: spinupPct(),
        }));
    }

    res.writeHead(404);
    res.end();
}).listen(3000, () => console.log(`Nuclear plant service running, ${CAPACITY_MW} MW capacity, ${SPINUP_MS} ms to criticality.`));

// Zie diesel-generator/server.js: PID 1 negeert SIGTERM zonder deze handler.
process.on("SIGTERM", () => process.exit(0));
