// Elke vijf seconden kijken we heoveel vermogen er beschikbaar is
// We vergelijken dit met de vraag en stellen het aantal dieselgeneratoren of kerncentrales bij.

const http = require("http");
const k8s = require("./k8s");

// Om de vijf seconden kijken we of we moeten schalen.
const TICK_MS = 5000;
const DIESEL_MW = 50;
const WIND_MW = 40;
const NUCLEAR_MW = 600;

// Zorgt ervoor dat alles zeker op één worker past als de andere uitvalt
const DIESEL_MAX = 12;
// Minimum waarde vooraleer we de kerncentrale opstarten.
const NUCLEAR_THRESHOLD = 150;
// Marge, we willen net iets meer capaciteit dan vraag. Om schommelingen op te vangen
const MARGIN = 1.1;
// Hoeveel generatoren dat we maximum afschalen per cyclus
const RAMP_DOWN_STEP = 2;

let demandMw = 0;
// Gebruikt voor het debuggen.
// Hiermee hebben we de NaN bug opgelost die hierboven beschreven is.
let lastDecision = "boot";
let lastError = null;

// Diesel en kernenergie hebben een vast vermogen. Voor wind moeten we dit opvragen bij de turbines zelf.
function podStatus(ip){
    return new Promise(resolve => {
        // Timeout is korter dan 5 seconden
        // Zonder timeout zou een turbine die niet bereikbaar is, het hele proces laten hangen
        // En dan kan er niet bijgestuurd woren wanneer het nodig is.
        const req = http.get({
            host: ip,
            port: 3000,
            path: "/status",
            timeout: 1500,
        }, res => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    resolve(json);
                }
                catch(error){
                    lastError = error.message;
                    resolve(null);
                }
            });
        });
        // null teruggeven bij fout of timeout. Dan kan één onbereikbare turbine de berekening niet laten falen
        req.on("timeout", () => {
            req.destroy();
            resolve(null);
        });
        req.on("error", () => resolve(null));
    });
}

async function windMw(pods){
    const turbines = pods.filter(pod => pod.source === "wind" && pod.ready && pod.ip);
    // Parallel alle turbines opvragen, serieel zou in het ergste scenario 8 x 1.5 seconden duren.
    // Dat is langer dan de cyclus van 5 seconden.
    const statuses = await Promise.all(turbines.map(turbine => podStatus(turbine.ip)));
    // Als we geen antwoord krijgen, dan geven we de optimische waarde terug.
    // 0 teruggeven zorgt ervoor dat we bijchakelen met diesel op basis van een netwerkhapering
    return statuses.reduce((total, status) => total + (status && Number.isFinite(status.capacityMw) ? status.capacityMw : WIND_MW), 0);
}

// De core van de grid controller.
// Elke cyclus berekenen we alles vanuit de huidige state.
// Hierdoor krijgen we idempotente reconciliëring.
// Gemiste cyclussen zijn onschadelijk, een herstart werkt direct
// Geen herstelprocedure nodig. Er is niks om te herstellen.

async function reconcile(){
    const pods = await k8s.listSourcePods();
    const readyBy = sourceName => pods.filter(pod => pod.source === sourceName && pod.ready).length;

    // Nu beschikbaar
    const wind = await windMw(pods);
    const nuclearReady = readyBy("nuclear") * NUCLEAR_MW;
    const nuclearWanted = await k8s.getReplicas("nuclear-plant");
    const dieselNow = await k8s.getReplicas("diesel-generator");

    // Hoeveel vermogen hebben we nodig nadat wind is meegerekend.
    const residual = Math.max(0, Math.ceil(demandMw * MARGIN) - wind);
    // Hebben we kernernergie nodig
    let nuclearTarget = nuclearWanted;
    if(residual >= NUCLEAR_THRESHOLD){
        nuclearTarget = 1;
    }
    else if(residual === 0){
        nuclearTarget = 0;
    }

    // Hoeveel dieselgeneratoren hebben we nodig
    // Residual moet nog gedekt worden diesel, wind was al meegerekend
    // Daar gaat de kernenergie vanaf, de rest deel ik door 50MW
    // Zolang nuclearReady 0 is blijft diesel alles opvangen.
    // Wanneer de readynessProbe omslaat, wordt nuclearReady 600 en blijft er niks over voor diesel.
    const dieselTarget = Math.min(DIESEL_MAX, Math.ceil(Math.max(0, residual - nuclearReady) / DIESEL_MW));

    // Opschalen is instant, afschalen doen we stapsgewijs
    const dieselNext = dieselTarget >= dieselNow ? dieselTarget : Math.max(dieselTarget, dieselNow - RAMP_DOWN_STEP);

    // We schrijven enkel als er iets veranderd.
    if(dieselNext !== dieselNow){
        await k8s.scale("diesel-generator", dieselNext);
    }
    if(nuclearTarget !== nuclearWanted){
        await k8s.scale("nuclear-plant", nuclearTarget);
    }

    lastDecision = `demand=${demandMw} wind=${wind} nuclearReady=${nuclearReady} residual=${residual} dieselTarget=${dieselTarget} diesel:${dieselNow}->${dieselNext} nuclear:${nuclearWanted}->${nuclearTarget}`;
    lastError = null;
    console.log(lastDecision);
}

http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    // Controller heeft geen opstarttijd, dus health en ready zijn altijd ok.
    if(url === "/health" || url === "/ready"){
        res.writeHead(200);
        return res.end("ok");
    }
    if(url === "/demand" && req.method === "POST"){
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", async () => {
            try {
                const mw = Number(JSON.parse(body).mw);
                // Validatie tot 1000 MW
                // Ontwerpcapaciteit ligt rond de 680 MW want boven die grens hoort het net
                // een tekort aan te geven, wat we willen kunnen aantonen.
                // De grens van 1000 MW is arbitrair, maar geeft een buffer voor de toekomst.
                if(!Number.isFinite(mw) || mw < 0 || mw > 1000){
                    res.writeHead(400, { "Content-Type": "application/json" });
                    return res.end(JSON.stringify({ error: "MW must be between 0 and 1000" }));
                }
                demandMw = mw;
                // We schrijven eerst naar de ConfigMap en antwoorden pas daarna.
                // Zo is de waarde opgeslagen en staat die niet enkel
                // in het geheugen van een pod die kan sterven.
                // Bij een heropstart blijft de vraagwaarde behouden.
                await k8s.writeDemand(mw);
                res.writeHead(200, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ demandMw }));
            }
            catch(error){
                res.writeHead(500, { "Content-Type": "application/json" });
                return res.end(JSON.stringify({ error: error.message }));
            }
        });
        return;
    }
    // Volledige status van het grid, gebruikt voor het dashboard
    if(url === "/state"){
        k8s.listAllPods().then(async allPods => {
            const pods = allPods.filter(pod => pod.source);
            const supply = sourceName => pods.filter(pod => pod.source === sourceName && pod.ready).length;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
                demandMw,
                supplyMw: {
                    wind: await windMw(pods),
                    diesel: supply("diesel") * DIESEL_MW,
                    nuclear: supply("nuclear") * NUCLEAR_MW,
                },
                pods,
                // Alle pods voor "pods per worker".
                // Cronjob pods die al klaar zijn filteren we eruit, die vervuilen enkel de lijst.
                allPods: allPods.filter(pod => pod.phase !== "Succeeded" && pod.phase !== "Failed"),
                controllerPod: process.env.HOSTNAME || "local",
                lastDecision,
                lastError,
            }));
        }).catch(error => {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: error.message }));
        });
        return;
    }
    res.writeHead(404);
    res.end();
}).listen(3000);

async function main(){
    // Als de pod sterft bij de chaostest, leest de nieuwe pod terug de juiste vraag in en gaat verder.
    // Op het dashboard zie je dan "controller rescheduled ... setpoint recovered"
    demandMw = await k8s.readDemand();
    console.log(`controller running on ${process.env.HOSTNAME}, demand is ${demandMw} MW`);
    setInterval(() => reconcile().catch(error => {
        lastError = error.message;
        console.error("reconcile:", lastError);
    }), TICK_MS);
}
main();

process.on("SIGTERM", () => process.exit(0));
