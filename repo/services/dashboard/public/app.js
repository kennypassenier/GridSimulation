const MAX_SAMPLES = 150;
const history = [];
const COLORS = { wind: "#4cc9f0", diesel: "#f4a259", nuclear: "#80ed99" };
const WORKERS = ["k3s-worker-1", "k3s-worker-2"];
// /api/chaos/status (Proxmox)
let vmStatusByName = {};
let prev = null;

// Fetch krijgt een harde timeout
// Zonder timeout kon de verbinding blijven hangen als een worker terwijl stierf
// Hierdoor bleven de gegevens van voor de shutdown op het scherm staan
const fetchJSON = async(url, opts = {}) => {
    const response = await fetch(url, { ...opts, signal: AbortSignal.timeout(4000) });
    if(response.status === 401){
        location.reload();
        throw new Error("sessie verlopen");
    }
    if(!response.ok){
        throw new Error((await response.json().catch(() => ({}))).error || `HTTP ${response.status}`);
    }
    return response.json();
};

function logEvent(tag, msg){
    const time = new Date().toLocaleTimeString("nl-BE");
    const eventLog = document.getElementById("eventlog");
    eventLog.innerHTML = `<div><span class="text-body-secondary">[${time}]</span><span class="text-body-secondary">${tag.padEnd(10)}</span> ${msg}</div>` + eventLog.innerHTML;
    while(eventLog.childElementCount > 200){
        eventLog.removeChild(eventLog.lastChild);
    }
}

// Logboek met gebeurtenissen
// We vergelijken de huidige snapshot met "prev"
function diffEvents(state){
    const counts = sourceName => state.pods.filter(pod => pod.source === sourceName && pod.ready).length;
    const snapshot = {
        demand: state.demandMw,
        diesel: counts("diesel"),
        wind: counts("wind"),
        nuclearState: (state.pods.find(pod => pod.source === "nuclear") || {}).ready ? "CRITICAL" : state.pods.some(pod => pod.source === "nuclear") ? "SPINNING_UP" : "OFF",
        controllerPod: state.controllerPod,
        short: (state.supplyMw.wind + state.supplyMw.diesel + state.supplyMw.nuclear) < state.demandMw,
    };
    if(prev){
        if(snapshot.demand !== prev.demand){
            logEvent("vraag", `${prev.demand} -> <b>${snapshot.demand} MW</b>`);
        }
        if(snapshot.diesel !== prev.diesel){
            logEvent("diesel", `generatoren ${prev.diesel} -> <b>${snapshot.diesel}</b> (${snapshot.diesel * 50} MW)`);
        }
        if(snapshot.wind !== prev.wind){
            logEvent("wind", `turbines ${prev.wind} -> <b>${snapshot.wind}</b>`);
        }
        if(snapshot.nuclearState !== prev.nuclearState){
            logEvent("nucleair", `${prev.nuclearState} -> <b>${snapshot.nuclearState}</b>`);
        }
        if(snapshot.controllerPod !== prev.controllerPod){
            logEvent("controller", `herplaatst: ${prev.controllerPod} -> <b>${snapshot.controllerPod}</b> (instelwaarde hersteld uit ConfigMap)`);
        }
        if(snapshot.short !== prev.short){
            logEvent("aanbod", snapshot.short ? "<b>TEKORT</b> - aanbod onder de vraag" : "hersteld - vraag gedekt");
        }
    }
    else {
        logEvent("systeem", "dashboard verbonden");
    }
    prev = snapshot;
}

async function login(){
    try {
        await fetchJSON("/api/login", { method: "POST", body: JSON.stringify({ password: document.getElementById("pw").value }) });
        document.getElementById("login").classList.add("d-none");
        document.getElementById("app").classList.remove("d-none");
        tick();
        chaosTick();
    }
    catch {
        document.getElementById("loginmsg").textContent = "Verkeerd wachtwoord";
    }
}

document.getElementById("pw").addEventListener("keydown", event => event.key === "Enter" && login());
document.getElementById("loginbtn").addEventListener("click", login);

// Voorkom dat de slider wordt teruggezet terwijl we slepen
let sliderBusy = false;
// Debounce, anders zouden we bij elke elke verandering een POST afvuren
let sliderTimer = null;
document.getElementById("slider").addEventListener("input", () => {
    sliderBusy = true;
    document.getElementById("demand").textContent = `${document.getElementById("slider").value} MW`;
    clearTimeout(sliderTimer);
    sliderTimer = setTimeout(async () => {
        try {
            await fetchJSON("/api/demand", { method: "POST", body: JSON.stringify({ mw: Number(document.getElementById("slider").value) }) });
        }
        catch(error){
            logEvent("waarschuwing", `vraag wijzigen mislukt: ${error.message}`);
        }
        sliderBusy = false;
    }, 400);
});

function drawChart(){
    const chart = document.getElementById("chart");
    const ctx = chart.getContext("2d");
    ctx.clearRect(0, 0, chart.width, chart.height);

    // We hebben 2 punten nodig om een lijn te trekken.
    if(history.length < 2){
        return;
    }

    // Bovenkant van de verticale as. Vaste schaal.
    // Bij een automatische schaal zou de grafiek bij elke piek
    // verspringen en zou je de hoogte van twee momenten niet kunnen vergelijken.
    const MAX_MW = 1250;

    // Twee omrekenfuncties van gegevens naar beeldpunten.
    // toX: meting 0 staat helemaal links, de laatste helemaal rechts.
    // toY: canvas telt van BOVEN naar beneden, dus 0 MW is chart.height en
    // MAX_MW is 0 - vandaar de aftrekking.
    const toX = index => index / (MAX_SAMPLES - 1) * chart.width;
    const toY = megawatt => chart.height - (megawatt / MAX_MW) * chart.height;

    // De onderrand van de eerste band ligt overal op nul.
    let baseline = history.map(() => 0);

    ["wind", "nuclear", "diesel"].forEach(source => {
        // De bovenrand van deze band: de vorige onderrand plus wat deze bron levert.
        const topEdge = history.map((sample, index) => baseline[index] + sample[source]);
        // Een gevuld vlak is een gesloten veelhoek. We lopen eerst van links
        // naar rechts langs de bovenrand, en daarna van rechts naar links
        // terug langs de onderrand. closePath sluit de vorm.
        ctx.beginPath();
        ctx.moveTo(toX(0), toY(baseline[0]));
        topEdge.forEach((megawatt, index) => ctx.lineTo(toX(index), toY(megawatt)));
        for(let index = history.length - 1; index >= 0; index--){
            ctx.lineTo(toX(index), toY(baseline[index]));
        }
        ctx.closePath();

        // "bb" achter de kleur is de doorzichtigheid in hexadecimale notatie
        // (#RRGGBBAA). Daardoor blijft de rasterlijn en
        // de band eronder nog zichtbaar.
        ctx.fillStyle = `${COLORS[source]}bb`;
        ctx.fill();

        // Deze bovenrand is de onderrand van de volgende bron.
        baseline = topEdge;
    });

    // De vraaglijn als laatste, zodat hij over de vlakken heen ligt.
    // De ternary regelt de eerste meting: daar zetten we de pen neer (moveTo),
    // bij alle volgende trekken we een lijn (lineTo).
    ctx.beginPath();
    ctx.strokeStyle = "#ef476f";
    ctx.lineWidth = 2;
    history.forEach((sample, index) => index
        ? ctx.lineTo(toX(index), toY(sample.demand))
        : ctx.moveTo(toX(index), toY(sample.demand)));
    ctx.stroke();
}

function renderNodeCols(allPods){
    const nodes = {};
    WORKERS.forEach(worker => nodes[worker] = []);
    (allPods || []).forEach(pod => {
        // Pods met deletionTimestamp zijn bewust afgeschaald en horen er niet meer bij
        if(pod.terminating){
            return;
        }
        (nodes[pod.node] = nodes[pod.node] || []).push(pod);
    });
    document.getElementById("nodecols").innerHTML = Object.keys(nodes).sort().map(node => {
        const vmState = vmStatusByName[node];
        const dead = vmState && vmState !== "running";
        const badge = vmState ? (dead ? `<span class="dot bad"></span>${vmState}` : `<span class="dot ok"></span>running`) : "";
        const pods = nodes[node].map(pod => {
            const classes = [pod.source ? "" : "infra", pod.ready ? "" : "notready", dead ? "stale" : ""].join(" ");
            const background = pod.source ? COLORS[pod.source] : "var(--infra)";
            return `<span class="pod ${classes}" style="background:${background}" title="${pod.name}">${pod.source || pod.app || pod.name}</span>`;
        }).join("");
        return `<div class="nodecol flex-fill ${dead ? "dead" : ""}">
            <div class="d-flex justify-content-between small mb-1">
                <span>${node} (${nodes[node].length})</span><span class="text-body-secondary">${badge}</span>
            </div>${pods || `<span class="text-body-secondary small">geen pods</span>`}</div>`;
    }).join("");
}

async function tick(){
    try {
        const state = await fetchJSON("/api/state");
        document.getElementById("banner").classList.add("d-none");
        if(!sliderBusy){
            document.getElementById("demand").textContent = `${state.demandMw} MW`;
            document.getElementById("slider").value = state.demandMw;
        }
        const total = state.supplyMw.wind + state.supplyMw.diesel + state.supplyMw.nuclear;
        document.getElementById("supply").innerHTML = `${total} MW${total < state.demandMw ? ` <span class="text-danger fw-bold fs-6">TEKORT</span>` : ""}`;
        ["wind", "diesel", "nuclear"].forEach(sourceName => document.getElementById(`mw-${sourceName}`).textContent = state.supplyMw[sourceName]);
        document.getElementById("supplybar").innerHTML = ["wind", "diesel", "nuclear"]
            .map(sourceName => `<div class="progress-bar" style="width:${total ? state.supplyMw[sourceName] / Math.max(total, state.demandMw) * 100 : 0}%;background-color:${COLORS[sourceName]}"></div>`).join("");
        const nuclearPod = state.pods.find(pod => pod.source === "nuclear" && !pod.ready && pod.phase === "Running");
        document.getElementById("nukeprog").textContent = nuclearPod ? `Kerncentrale start op, op ${nuclearPod.node}...` : "";
        renderNodeCols(state.allPods || state.pods);
        document.getElementById("ticker").textContent = `${state.lastError ? `FOUT ${state.lastError} | ` : ""}${state.lastDecision} (controller-pod: ${state.controllerPod})`;
        diffEvents(state);
        history.push({ t: Date.now(), demand: state.demandMw, ...state.supplyMw });
        if(history.length > MAX_SAMPLES){
            history.shift();
        }
        drawChart();
    }
    catch(error){
        document.getElementById("banner").textContent = `Cluster onbereikbaar (${error.message}) - opnieuw proberen... dit is normaal gedurende ongeveer 20 seconden na een kill`;
        document.getElementById("banner").classList.remove("d-none");
    }
    setTimeout(tick, 2000);
}

async function chaosTick(){
    try {
        const list = await fetchJSON("/api/chaos/status");
        const previousStatus = { ...vmStatusByName };
        list.forEach(vm => {
            if(previousStatus[vm.name] && previousStatus[vm.name] !== vm.status){
                logEvent("vm", `<b>${vm.name}</b>: ${previousStatus[vm.name]} -> <b>${vm.status}</b>`);
            }
            vmStatusByName[vm.name] = vm.status;
        });
        document.getElementById("chaos").innerHTML = list.map(vm =>
            `<div class="d-flex align-items-center gap-2 my-2">
                <b style="width:110px">${vm.name}</b>
                <span class="text-body-secondary" style="width:90px"><span class="dot ${vm.status === "running" ? "ok" : "bad"}"></span>${vm.status}</span>
                ${vm.status === "running"
                    ? `<button class="btn btn-danger btn-sm" onclick="chaos('${vm.name}','stop')">Harde shutdown</button>`
                    : `<button class="btn btn-secondary btn-sm" onclick="chaos('${vm.name}','start')">Aanzetten</button>`}
            </div>`).join("");
    }
    catch(error){
        document.getElementById("chaos").innerHTML = `<span class="text-body-secondary small">chaos-API opnieuw proberen... (${error.message})</span>`;
    }
    setTimeout(chaosTick, 3000);
}

async function chaos(vm, action){
    if(action === "stop" && !confirm(`${vm} hard afsluiten? (virtuele stekker eruit)`)){
        return;
    }
    try {
        await fetchJSON(`/api/chaos/${vm}/${action}`, { method: "POST" });
        logEvent("chaos", action === "stop" ? `<b>HARDE SHUTDOWN</b> verstuurd naar ${vm}` : `aanzetten verstuurd naar ${vm}`);
    }
    catch(error){
        alert(error.message);
        logEvent("chaos", `${action} ${vm} geweigerd: ${error.message}`);
    }
}
