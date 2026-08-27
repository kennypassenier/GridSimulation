// Alle code die met Kubernetes praat komt hieronder te staan
// Authenticatie: Ik geef nergens een wachtwoord of kubeconfig mee.
// Als ik in het bestand repo/k8s/20-apps.yaml "serviceAccountName: grid-controller" heb gezet,
// dan koppelt de kubelet automatisch drie bestanden in mijn pod. In het geheugen (tmpfs, niet op de schijf zelf)
// ca.crt => certificaat
// token => een JWT token die ons identificeert
// namespace => de namespace waarin we draaien
// Welke rechten daarbij horen staat in repo/k8s/00-namespace-rbac.yaml
// Gebaseerd op least privilege. De controller kan enkel wat expliciet is toegestaan, zelfs moest de code het proberen


const https = require("https");
const fs = require("fs");

// De map warin Kubernetes de account van deze pot klaarzet.
const SA = "/var/run/secrets/kubernetes.io/serviceaccount";
// Veranderd nooit, mag direct ingelezen worden.
const ca = fs.readFileSync(`${SA}/ca.crt`);
const NS = process.env.NAMESPACE || fs.readFileSync(`${SA}/namespace`, "utf8").trim();

const HOST = process.env.KUBERNETES_SERVICE_HOST;
const PORT = process.env.KUBERNETES_SERVICE_PORT || 443;

function api(method, path, body, contentType){
    // token elke aanvraag uitlezen van schijf
    // k3s gebruikt "projected service account tokens" die 1 uur geldig zijn.
    // De kubelet ververst die automatisch door het bestand over te schrijven.
    const token = fs.readFileSync(`${SA}/token`, "utf8");

    // Door dat https callbcks gebruikt kunnen we async/await niet gebruiken.
    // Hiervoor gebruiken we een promise wrapper.
    return new Promise((resolve, reject) => {
        const req = https.request({
            host: HOST,
            port: PORT,
            path,
            method,
            ca,
            headers: {
                "Authorization": `Bearer ${token}`,
                ...(body ? { "Content-Type": contentType || "application/json" } : {}),
            },
        }, res => {
            let data = "";
            // Data komt in stukken binnen, die plakken we zelf samen.
            res.on("data", chunk => data += chunk);
            // Hier is het volledige antwoord binnen
            res.on("end", () => {
                let json = {};
                try {
                    json = data ? JSON.parse(data) : {};
                }
                catch(error){
                    // Sommige errors geven platte tekst in plaats van JSON.
                    // We willen de echte statuscode kunnen doorgeven
                    // Dus we laten het parsen van de data mislukken, zonder te crashen.
                    console.error("Kubernetes API returned invalid JSON", data);
                }
                // Alles boven statuscode 400 betekent dat de aanvraag mislukt is.
                if(res.statusCode >= 400){
                    const error = new Error(`${method} ${path} -> ${res.statusCode} ${json.message || ""}`);
                    // Statuscode meegeven. Zo kunnen we onderscheid maken tussen 404 en 403 fouten (RBAC)
                    error.code = res.statusCode;
                    return reject(error);
                }
                resolve(json);
            });
        });
        req.on("error", reject);
        // Enkel een body meegeven als die bestaat.
        if(body){
            req.write(JSON.stringify(body));
        }
        // Effectief de aanvraag versturen.
        req.end();
    });
}

// Haalt al onze pods op in onze namespace en zet ze om naar een simpeler formaat
// listpods("role=power-source") -> Enkel onze stroombronnen
// listpods() -> Alle pods (gebruikt in ons dashboard)
async function listPods(selector){
    // encodeURIComponent zorgt ervoor dat de querystring correct is voor in een URL te gebruiken.
    const query = selector ? `?labelSelector=${encodeURIComponent(selector)}` : "";
    // API geeft een lijst terug, items zitten in result.items
    const result = await api("GET", `/api/v1/namespaces/${NS}/pods${query}`);

    return result.items.map(pod => {
        const labels = pod.metadata.labels || {};
        // Als een pod verwijderd gaat worden krijgt die eerst deletionTimestamp, dan SIGTERM
        // !! forceert een boolean in geval van undefined.
        const terminating = !!pod.metadata.deletionTimestamp;

        return {
            name: pod.metadata.name,
            app: labels.app,
            source: labels.source,
            ip: pod.status.podIP,
            // Niet ingeplande nodes hebben geen nodeName.
            // Edge case voor de paar milliseconden dat de pod bestaat en de scheduler de node gekozen heeft
            node: pod.spec.nodeName || "unscheduled",
            // Running, pending, succeeded, failed zijn mogelijk
            phase: pod.status.phase,
            terminating,
            // Pod is niet aan het afsluiten en Kubernetes heeft de pod als "ready" gemarkeerd.
            ready: !terminating && (pod.status.conditions || []).some(condition => condition.type === "Ready" && condition.status === "True"),
        };
    });
}

const listSourcePods = () => listPods("role=power-source");
const listAllPods = () => listPods();

// Schalen gaat via de scale-subresource, niet via de deployment.
// In 00-namespace-rbac.yaml krijgt de controller alleen deployments/scale met get en patch.
// Hij kan het aantal replicas wijzigen, maar niet het image, de environment variabelen of de probes.
const scalePath = deployment => `/apis/apps/v1/namespaces/${NS}/deployments/${deployment}/scale`;

async function getReplicas(deployment){
    // De scale resource is in Go gedefinieerd als "json:'replicas,omitempty'"
    // omitempty als de waarde 0 is, laat het veld dan weg uit de JSON.
    // Als er geen replicas zijn dan krijgen we {"spec": {}} terug zonder het veld "replicas".
    // Alle volgende berekeningen worden dan NaN zonder foutmelding of crash.
    // Controller blijft draaien en stopt met schalen.
    return (await api("GET", scalePath(deployment))).spec.replicas || 0;
}

async function scale(deployment, replicas){
    // PATH ipv PUT zodat we enkel het veld "replicas" kunnen aanpassen.
    await api("PATCH", scalePath(deployment), {
        spec: {
            replicas
        }
    }, "application/merge-patch+json");
}

async function readDemand(){
    try {
        const configMap = await api("GET", `/api/v1/namespaces/${NS}/configmaps/grid-demand`);
        return Number(configMap.data.demandMw);
    }
    catch(error){
        if(error.code === 404){
            return 0;
        }
        throw error;
    }
}

async function writeDemand(mw){
    const configMap = {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: {
            name: "grid-demand"
        },
        data: {
            demandMw: String(mw)
        }
    };
    try {
        await api("PUT", `/api/v1/namespaces/${NS}/configmaps/grid-demand`, configMap);
    }
    catch(error){
        // Als de configmap nog niet bestaat, maken we hem zelf aan.
        // Scheelt een extra controle voor elke schrijfactie.
        if(error.code === 404){
            await api("POST", `/api/v1/namespaces/${NS}/configmaps`, configMap);
        }
        else {
            throw error;
        }
    }
}

module.exports = {
    listSourcePods,
    listAllPods,
    getReplicas,
    scale,
    readDemand,
    writeDemand,
};
