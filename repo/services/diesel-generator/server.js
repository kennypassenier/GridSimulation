// Dieselgenerator: de snelle, regelbare stroombron.
// Eén pod = één fysieke generator van 50 MW. De grid-controller schaalt het
// aantal replicas van deze Deployment; het totale dieselvermogen is dus
// "aantal gereedgemelde pods x 50 MW". Replicas zijn hier geen abstracte
// containertelling maar fysieke opwekeenheden.
//
// Bewust drie aparte services en niet één met een type-parameter:
// elke bron moet apart schaalbaar zijn, dus elke bron krijgt zijn eigen
// Deployment met zijn eigen schaalknop.
//
// Geen Express of andere dependencies: deze service heeft exact drie routes.
// Met de ingebouwde http-module is er geen node_modules, geen supply chain,
// en blijft de image klein (sneller herstarten tijdens de chaostest).

const http = require("http");

// Configuratie via environment variables in plaats van constanten in de code.
// Zo staat de capaciteit zichtbaar in 10-sources.yaml en kan dezelfde image
// in theorie ook een generator van een ander vermogen zijn.
const CAPACITY_MW = Number(process.env.CAPACITY_MW || 50);

// Een generator levert niet onmiddellijk vermogen: hij moet op toerental komen.
// Het verschil tussen "de container draait" en "de generator levert stroom"
// is precies wat de readinessProbe meet.
const WARMUP_MS = Number(process.env.WARMUP_MS || 2000);

// Per pod, niet globaal: een herplaatste pod doorloopt zijn opstart opnieuw.
const startedAt = Date.now();

const ready = () => Date.now() - startedAt >= WARMUP_MS;

http.createServer((req, res) => {
    // Liveness: leeft het proces nog? Altijd 200 zolang we draaien.
    // Dit is iets anders dan /ready hieronder. Zou de livenessProbe naar
    // /ready wijzen, dan ziet Kubernetes een opstartende eenheid als kapot
    // en herstart hij hem eindeloos (CrashLoopBackOff).
    if(req.url === "/health"){
        res.writeHead(200);
        return res.end("ok");
    }
    // Readiness: kan deze eenheid NU stroom leveren?
    // 503 tijdens het opwarmen, 200 daarna. Kubernetes leidt hieruit de
    // Ready-conditie af waar de controller mee rekent. De eenheid zelf is
    // dus de enige plek die weet of hij inzetbaar is.
    if(req.url === "/ready"){
        res.writeHead(ready() ? 200 : 503);
        return res.end();
    }
    // De eenheid beschrijft zichzelf, voor het dashboard.
    // De controller rekent voor diesel met een vaste 50 MW per gereedgemelde
    // pod en bevraagt deze route niet; bij wind ligt dat anders.
    if(req.url === "/status"){
        res.writeHead(200, {
            "Content-Type": "application/json"
        });
        return res.end(JSON.stringify({
            source: "diesel",
            // HOSTNAME wordt door Kubernetes gezet op de podnaam.
            unit: process.env.HOSTNAME || "local",
            // Nul zolang de generator opwarmt: wie opstart levert niets.
            capacityMw: ready() ? CAPACITY_MW : 0,
            state: ready() ? "RUNNING" : "STARTING",
        }));
    }

    res.writeHead(404);
    res.end();
// Geen host-argument bij listen: luisteren op alle interfaces. Moet ook,
// want de kubelet voert de probes uit tegen het pod-IP, niet tegen localhost.
}).listen(3000, () => console.log(`Diesel generator service running, ${CAPACITY_MW} MW capacity, ${WARMUP_MS} ms warmup.`));

// Node draait als PID 1 in de container en PID 1 krijgt van de kernel geen
// standaard-signaalafhandeling. Zonder deze regel wordt SIGTERM genegeerd en
// blijft elke pod de volle 30 seconden grace period hangen voor SIGKILL komt,
// terwijl hij zich nog als ready rapporteert. De afbouw lijkt dan vast te lopen.
process.on("SIGTERM", () => process.exit(0));
