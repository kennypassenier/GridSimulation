// Statische html tonen
// Proxy voor de grid-controller
// Chaos knop om een worker af te zetten

const http = require("http");
// Proxmox luistert enkel via HTTPS
const https = require("https");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

// Backup url gebruik de interne DNS van Kubernetes (standaard meegeleverd bij k3s)
const CONTROLLER = process.env.CONTROLLER_URL || "http://grid-controller.grid.svc";

// Wachtwoord uit de Secret dashboard-secrets
// Backup "grid" is om het lokaal te kunnen draaien
// In de cluster wordt die altijd overschreven door envFrom uit 20-apps.yaml
const PASSWORD = process.env.DASH_PASSWORD || "grid";
// Sessiecookie sleutel, afgeleid van het wachtwoord.
// Bewust geen tweede geheim, is niet nodig in dit geval
// Heeft als nut dat als het wachtwoord verandert, alle bestaande sessies ongeldig worden.
const SECRET = crypto.createHash("sha256").update(`cookie:${PASSWORD}`).digest();

const PVE_URL = process.env.PVE_URL || "";
const PVE_TOKEN = process.env.PVE_TOKEN || "";
const PVE_NODE = process.env.PVE_NODE || "proxmox";

// Allowlist
const TARGETS = { "k3s-worker-1": 202, "k3s-worker-2": 203 };

const sign = value => crypto.createHmac("sha256", SECRET).update(value).digest("hex");

const makeCookie = () => {
    const t = String(Date.now());
    return `${t}.${sign(t)}`;
};

const validCookie = cookie => {
    if(!cookie){
        return false;
    }
    const [t, mac] = cookie.split(".");
    if(!t || !mac){
        return false;
    }
    // we gebruiken timingSafeEqual want een "===" stopt vanaf het eerste verschil.
    // Dat maakt ons kwetsbaar voor timing attacks.
    // timingSafeEqual heeft dit probleem niet
    try {
        return crypto.timingSafeEqual(Buffer.from(sign(t)), Buffer.from(mac));
    }
    catch(error){
        return false;
    }
};

const authed = req => validCookie((req.headers.cookie || "").split("grid_session=")[1]?.split(";")[0]);

const pveAgent = new https.Agent({
    rejectUnauthorized: false,
});

function pve(method, apiPath){
    return new Promise((resolve, reject) => {
        const parsedUrl = new URL(`${PVE_URL}/api2/json${apiPath}`);
        const req = https.request({
            host: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname,
            method,
            // PVEAPIToken een token van gebruiker chaosbot@pve
            // Deze kan enkel power-management toepassen op de resource pool met de twee workers
            agent: pveAgent,
            headers: {
                "Authorization": `PVEAPIToken=${PVE_TOKEN}`,
            }
        }, res => {
            let data = "";
            res.on("data", chunk => data += chunk);
            res.on("end", () => {
                res.statusCode >= 400 ? reject(new Error(`PVE ${res.statusCode}`)) : resolve(JSON.parse(data).data);
            });
        });
        req.on("error", reject);
        req.end();
    });
}

const vmStatus = vmid => pve("GET", `/nodes/${PVE_NODE}/qemu/${vmid}/status/current`).then(data => data.status);

// Controller proxy
// Alle browser API calls gaan naar hetzelfde adres. Geen CORS problemen.
// Controller heeft zelf geen authenticatie.
// Service is van het type ClusterIP: enkel bereikbaar binnen het cluster.
function proxyJSON(method, url, body, res){
    const parsedUrl = new URL(url);
    const proxyRequest = http.request({
        host: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.pathname,
        method,
        headers: body ? {
            "Content-Type": "application/json"
        } : {},
    }, proxyResponse => {
        res.writeHead(proxyResponse.statusCode, {
            "Content-Type": "application/json"
        });
        // pipe: De response van de controller rechtstreeks doorgeven.
        proxyResponse.pipe(res);
    });
    proxyRequest.on("error", error => {
        res.writeHead(502);
        res.end(JSON.stringify({ error: error.message }));
    });
    if(body){
        proxyRequest.write(body);
    }
    proxyRequest.end();
}

http.createServer((req, res) => {
    const url = req.url.split("?")[0];
    // De kubelet die dit uitvoert heeft geen sessiecooikies dus deze URL's moeten voor de
    // authenticatie controle staan
    if(url === "/health" || url === "/ready"){
        res.writeHead(200);
        return res.end("ok");
    }

    // Inloggen
    if(url === "/api/login" && req.method === "POST"){
        let body = "";
        req.on("data", chunk => body += chunk);
        req.on("end", () => {
            let password = "";
            try {
                password = JSON.parse(body).password || "";
            }
            catch(error){
                console.error("Invalid login request", body);
            }
            // Terug timingSafeEqual gebruiken om timing attacks te voorkomen
            const passwordBuffer = Buffer.from(password);
            const expectedBuffer = Buffer.from(PASSWORD);
            if(passwordBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(passwordBuffer, expectedBuffer)){
                res.writeHead(200, { "Set-Cookie": `grid_session=${makeCookie()}; HttpOnly; Path=/; Max-Age=86400`, "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true }));
            }
            else {
                res.writeHead(401);
                res.end(JSON.stringify({ error: "wrong password" }));
            }
        });
        return;
    }

    if(url.startsWith("/api/")){
        // Alles onder /api vereist een geldige sessie
        if(!authed(req)){
            res.writeHead(401, { "Content-Type": "application/json" });
            return res.end(JSON.stringify({ error: "login required" }));
        }
        if(url === "/api/state"){
            return proxyJSON("GET", `${CONTROLLER}/state`, null, res);
        }
        if(url === "/api/demand" && req.method === "POST"){
            let body = "";
            req.on("data", chunk => body += chunk);
            req.on("end", () => proxyJSON("POST", `${CONTROLLER}/demand`, body, res));
            return;
        }
        // Status voor beide VM's
        // Wordt om de 3 seconden opgevraagd
        // Hierdoor kunnen we het paneel binnen enkele seconden updaten na een kill command
        // Kubernetes doet er zelf ongeveer 30 seconden over om zijn pods op te ruimen.
        if(url === "/api/chaos/status"){
            Promise.all(Object.entries(TARGETS).map(async ([name, id]) => ({
                name,
                vmid: id,
                status: await vmStatus(id)
            }))).then(list => {
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(list));
            }).catch(error => {
                res.writeHead(502);
                res.end(JSON.stringify({ error: error.message }));
            });
            return;
        }

        // Chaos knop: docent kan een worker afsluiten.
        // We gebruiken een regex om de VM-naam en de actie uit de URL te halen.
        // bv /api/chaos/k3s-worker-1/stop
        const chaosMatch = url.match(/^\/api\/chaos\/([^/]+)\/(stop|start)$/);
        if(chaosMatch && req.method === "POST"){
            // Check de allowlist. Enkel namen die in TARGETS staan worden geaccepteerd
            const vmid = TARGETS[chaosMatch[1]];
            if(!vmid){
                res.writeHead(403);
                return res.end(JSON.stringify({ error: "not a chaos target" }));
            }
            (async () => {
                if(chaosMatch[2] === "stop"){
                    // Een stop mag enkel werken als er nog geen andere worker gestopt is
                    const others = await Promise.all(Object.values(TARGETS).filter(id => id !== vmid).map(vmStatus));
                    if(others.some(status => status !== "running")){
                        res.writeHead(403, { "Content-Type": "application/json" });
                        return res.end(JSON.stringify({ error: "another worker is already down; restore it first" }));
                    }
                }
                // status/stop is een harde shutdown
                await pve("POST", `/nodes/${PVE_NODE}/qemu/${vmid}/status/${chaosMatch[2]}`);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ ok: true, vmid, action: chaosMatch[2] }));
            })().catch(error => {
                res.writeHead(502);
                res.end(JSON.stringify({ error: error.message }));
            });
            return;
        }
        res.writeHead(404);
        return res.end();
    }

    const file = url === "/" ? "/index.html" : url;
    // replace hieronder is een beveiliging tegen path traversal attacks.
    // Een verzoek naar /../../etc/passwd zou via path.join bestanden van het systeem kunnen uitlezen.
    // Met path.normalise garandeer je dat je binnen public/ blijft.
    const filePath = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.(\/|\\|$))+/, ""));
    fs.readFile(filePath, (err, data) => {
        if(err){
            res.writeHead(404);
            return res.end("not found");
        }
        const types = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript" };
        res.writeHead(200, { "Content-Type": types[path.extname(filePath)] || "text/plain" });
        res.end(data);
    });
}).listen(3000, () => console.log("Dashboard service is running"));

process.on("SIGTERM", () => process.exit(0));
