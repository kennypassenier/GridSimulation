const http = require("http");
const CAPACITY_MW = Number(process.env.CAPACITY_MW || 40);
// Tijd die de turbine nodig heeft voor één volledige cyclus van zwak naar sterk naar zwak.
const GUST_PERIOD_MS = Number(process.env.GUST_PERIOD_MS || 180000);
const WARMUP_MS = Number(process.env.WARMUP_MS || 2000);
const startedAt = Date.now();

const ready = () => Date.now() - startedAt >= WARMUP_MS;

// Random waarde, anders lopen alle turbines synchroon
const phase = Math.random() * 2 * Math.PI;

const currentMw = () => {
    // Gebruikte functie gebaseerd op https://riptutorial.com/javascript/example/10173/periodic-functions-using-math-sin
    if(!ready()){
        return 0;
    }
    const time = (Date.now() / GUST_PERIOD_MS) * 2 * Math.PI;
    return Math.round(CAPACITY_MW * (0.75 + 0.25 * Math.sin(time + phase)));
};

http.createServer((req, res) => {
    if(req.url === "/health"){
        res.writeHead(200);
        return res.end("ok");
    }
    if(req.url === "/ready"){
        res.writeHead(ready() ? 200 : 503);
        return res.end();
    }
    if(req.url === "/status"){
        res.writeHead(200, {
            "Content-Type": "application/json"
        });
        return res.end(JSON.stringify({
            source: "wind",
            unit: process.env.HOSTNAME || "local",
            capacityMw: currentMw(),
            ratedMw: CAPACITY_MW,
            state: ready() ? "RUNNING" : "STARTING",
        }));
    }

    res.writeHead(404);
    res.end();
}).listen(3000, () => console.log(`Wind farm service running, ${CAPACITY_MW} MW capacity, ${GUST_PERIOD_MS} ms gust period, ${WARMUP_MS} ms warmup.`));

process.on("SIGTERM", () => process.exit(0));
