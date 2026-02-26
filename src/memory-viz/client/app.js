// app.js

const CONFIG = {
    similarityThreshold: 0.5,
    maxSimilarityLinks: 5,
    nodeRadius: 3, // Smaller nodes for elegance
    layout: {
        alphaDecay: 0.05,
        velocityDecay: 0.6,
    }
};

const customPalette = [
    "#00e5ff", "#00ff9d", "#ff00a0", "#ffaa00",
    "#7000ff", "#ff003c", "#0055ff", "#e0ff00",
    "#ff00ff", "#00ffea"
];

let state = {
    nodes: [],
    links: [],
    simLinks: [],
    width: window.innerWidth,
    height: window.innerHeight,
    transform: d3.zoomIdentity,
    hoveredNode: null,
    draggedNode: null,
    isPhysicsActive: true,
    showLabels: false,
    searchQuery: "",
    semanticChainsText: "",
    hoverDistances: new Map(),
    fadeCoeff: 0.3
};

let simulationRef = null;
let nodePositionCache = new Map();
let adjacencyList = new Map();

const container = d3.select("#universe");
const canvas = container.append("canvas")
    .attr("width", state.width)
    .attr("height", state.height)
    .style("position", "absolute")
    .style("top", "0")
    .style("left", "0");

const context = canvas.node().getContext("2d", { alpha: false });

window.addEventListener("resize", () => {
    state.width = window.innerWidth;
    state.height = window.innerHeight;
    canvas.attr("width", state.width).attr("height", state.height);
    if (simulationRef && state.isPhysicsActive) {
        simulationRef.force("center", d3.forceCenter(state.width / 2, state.height / 2).strength(0.01));
        simulationRef.alpha(0.1).restart();
    }
    requestAnimationFrame(render);
});

const tooltip = d3.select("#tooltip");

// --- UTILS ---
function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < vecA.length; i++) {
        dot += vecA[i] * vecB[i];
        magA += vecA[i] * vecA[i];
        magB += vecB[i] * vecB[i];
    }
    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag === 0 ? 0 : dot / mag;
}

function hashString(input) {
    let hash = 0;
    for (let i = 0; i < input.length; i++) {
        hash = ((hash << 5) - hash) + input.charCodeAt(i);
        hash |= 0;
    }
    return Math.abs(hash);
}

function getDeterministicStartPosition(id, centerX, centerY) {
    const hash = hashString(String(id));
    const angle = (hash % 360) * (Math.PI / 180);
    const radius = 40 + (hash % 220);
    return {
        x: centerX + Math.cos(angle) * radius,
        y: centerY + Math.sin(angle) * radius,
    };
}

function snapshotNodePositions(nodes) {
    const next = new Map();
    for (const node of nodes || []) {
        if (!node || !node.id) continue;
        if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
        next.set(node.id, { x: node.x, y: node.y });
    }
    nodePositionCache = next;
}

function buildAdjacencyList(nodes, links) {
    adjacencyList.clear();
    for (const n of nodes) adjacencyList.set(n.id, new Set());
    for (const l of links) {
        const sId = typeof l.source === 'object' ? l.source.id : l.source;
        const tId = typeof l.target === 'object' ? l.target.id : l.target;
        if (adjacencyList.has(sId)) adjacencyList.get(sId).add(tId);
        if (adjacencyList.has(tId)) adjacencyList.get(tId).add(sId);
    }
}

function updateMatches() {
    state.nodes.forEach(node => {
        let filterMatch = true;
        if (state.searchQuery) {
            filterMatch = node.text.toLowerCase().includes(state.searchQuery) ||
                (node.topics && node.topics.some(t => t.toLowerCase().includes(state.searchQuery)));
        }
        let searchMatch = true;
        if (state.semanticChainsText) {
            searchMatch = state.semanticChainsText.includes(node.text);
        }
        node._match = filterMatch && searchMatch;
    });
}

function isConnected(a, b) {
    return adjacencyList.has(a.id) && adjacencyList.get(a.id).has(b.id);
}

// --- DATA PROCESSING ---
function processData(data) {
    const rawNodes = data.nodes;
    const rawLinks = data.links;
    const nodeMap = new Map(rawNodes.map(n => [n.id, n]));

    const links = rawLinks.map(l => ({
        source: l.source,
        target: l.target,
        type: "explicit",
        relation: l.relation,
        confidence: l.confidence
    })).filter(l => nodeMap.has(l.source) && nodeMap.has(l.target));

    const simLinks = [];
    if (rawNodes.length < 2000) {
        for (let i = 0; i < rawNodes.length; i++) {
            const a = rawNodes[i];
            if (!a.embedding || a.embedding.length === 0) continue;

            const candidates = [];
            for (let j = i + 1; j < rawNodes.length; j++) {
                const b = rawNodes[j];
                if (!b.embedding || b.embedding.length === 0) continue;

                const sim = cosineSimilarity(a.embedding, b.embedding);
                if (sim > CONFIG.similarityThreshold) {
                    candidates.push({ id: b.id, sim });
                }
            }
            candidates.sort((c1, c2) => c2.sim - c1.sim).slice(0, CONFIG.maxSimilarityLinks);
            for (const c of candidates) {
                simLinks.push({
                    source: a.id,
                    target: c.id,
                    type: "semantic",
                    confidence: c.sim
                });
            }
        }
    }
    return { nodes: rawNodes, links, simLinks };
}

// --- VISUALIZATION ---
function initVis(data) {
    snapshotNodePositions(state.nodes);
    if (simulationRef) simulationRef.stop();

    d3.select("#fact-count").text(data.nodes.length);
    d3.select("#link-count").text(data.links.length);

    const { nodes, links, simLinks } = processData(data);
    state.nodes = nodes;
    state.links = links;
    state.simLinks = simLinks;

    const allLinks = [...links, ...simLinks];
    buildAdjacencyList(nodes, allLinks);

    const centerX = state.width / 2;
    const centerY = state.height / 2;

    const topicColors = d3.scaleOrdinal(customPalette);
    for (const node of nodes) {
        const cached = nodePositionCache.get(node.id);
        if (cached) {
            node.x = cached.x; node.y = cached.y;
            node.vx = 0; node.vy = 0;
        } else {
            const start = getDeterministicStartPosition(node.id, centerX, centerY);
            node.x = start.x; node.y = start.y;
            node.vx = 0; node.vy = 0;
        }

        const t = node.topics && node.topics.length > 0 ? node.topics[0] : "unknown";
        node.color = topicColors(t);
    }
    updateMatches();

    simulationRef = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(allLinks).id(d => d.id).distance(d => d.type === 'explicit' ? 80 : 120).strength(l => {
            return l.type === 'explicit' ? 0.8 : (l.confidence * 0.05);
        }))
        .force("charge", d3.forceManyBody().strength(-300).distanceMax(800))
        .force("center", d3.forceCenter(centerX, centerY).strength(0.01))
        .force("collide", d3.forceCollide().radius(CONFIG.nodeRadius + 6).iterations(1))
        .alphaDecay(CONFIG.layout.alphaDecay)
        .velocityDecay(CONFIG.layout.velocityDecay)
        .on("tick", render);

    if (!state.isPhysicsActive) simulationRef.stop();

    const zoom = d3.zoom()
        .scaleExtent([0.05, 10])
        .on("zoom", (event) => {
            state.transform = event.transform;
            render();
        });

    canvas.call(zoom)
        .call(zoom.transform, state.transform || d3.zoomIdentity)
        .call(d3.drag()
            .container(canvas.node())
            .subject(dragSubject)
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended));

    canvas.on("mousemove", (event) => {
        const [x, y] = d3.pointer(event);
        const tx = state.transform.invertX(x);
        const ty = state.transform.invertY(y);

        let found = null;
        let minDistSq = Infinity;
        // Hitbox scaled correctly inversely with zoom
        const hitRadius = Math.max((CONFIG.nodeRadius * 4) / state.transform.k, CONFIG.nodeRadius * 1.5);
        const hitRadiusSq = hitRadius * hitRadius;

        for (let i = nodes.length - 1; i >= 0; i--) {
            const n = nodes[i];
            const dx = tx - n.x;
            const dy = ty - n.y;
            const distSq = dx * dx + dy * dy;

            if (distSq < hitRadiusSq && distSq < minDistSq) {
                found = n;
                minDistSq = distSq;
            }
        }

        if (state.hoveredNode !== found) {
            state.hoveredNode = found;
            state.hoverDistances.clear();
            if (found) {
                canvas.style("cursor", "pointer");
                showTooltip(event, found);
                state.hoverDistances.set(found.id, 0);
                const queue = [found.id];
                let head = 0;
                while (head < queue.length) {
                    const currentId = queue[head++];
                    const dist = state.hoverDistances.get(currentId);
                    if (dist >= 10) continue; // max 10 hops for perf mapping
                    const neighbors = adjacencyList.get(currentId);
                    if (neighbors) {
                        for (const nId of neighbors) {
                            if (!state.hoverDistances.has(nId)) {
                                state.hoverDistances.set(nId, dist + 1);
                                queue.push(nId);
                            }
                        }
                    }
                }
            } else {
                canvas.style("cursor", "grab");
                hideTooltip();
            }
            requestAnimationFrame(render);
        } else if (found) {
            tooltip.style("left", (event.pageX + 15) + "px")
                .style("top", (event.pageY + 15) + "px");
        }
    });

    render();
}

// --- RENDER ---
function render() {
    context.save();
    context.fillStyle = "#050508";
    context.fillRect(0, 0, state.width, state.height);

    context.translate(state.transform.x, state.transform.y);
    context.scale(state.transform.k, state.transform.k);

    const k = state.transform.k;
    const viewport = {
        minX: state.transform.invertX(0),
        maxX: state.transform.invertX(state.width),
        minY: state.transform.invertY(0),
        maxY: state.transform.invertY(state.height)
    };

    context.lineWidth = 1.0 / k;
    for (const link of state.links) {
        const s = link.source;
        const t = link.target;

        const isHovered = (state.hoveredNode === s || state.hoveredNode === t);
        const isActiveFilter = state.searchQuery || state.semanticChainsText;
        if (!isHovered && isActiveFilter && !s._match && !t._match) continue;

        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const distSq = dx * dx + dy * dy;

        if (!isHovered && distSq > 250000) continue;

        const dist = Math.sqrt(distSq);
        let baseOpacity = Math.max(0.01, 1.0 - (dist / 400));
        if (distSq > 10000) baseOpacity *= 0.5;

        if (state.hoveredNode) {
            const distS = state.hoverDistances.has(s.id) ? state.hoverDistances.get(s.id) : Infinity;
            const distT = state.hoverDistances.has(t.id) ? state.hoverDistances.get(t.id) : Infinity;
            const linkDist = Math.max(distS, distT);

            if (isHovered) {
                baseOpacity = 0.8;
            } else if (linkDist === Infinity) {
                baseOpacity *= 0.05;
            } else {
                baseOpacity *= Math.max(0.05, 1.0 - (linkDist * state.fadeCoeff));
            }
        }

        if (baseOpacity < 0.02 && !isHovered) continue;

        if (link.type === 'explicit') {
            context.strokeStyle = `rgba(0, 229, 255, ${baseOpacity})`;
        } else {
            context.strokeStyle = `rgba(138, 138, 158, ${baseOpacity * 0.4})`;
        }

        if (isHovered) {
            context.lineWidth = 2.0 / k;
            context.strokeStyle = `rgba(255, 255, 255, 0.9)`;
        } else {
            context.lineWidth = (Math.max(0.5, link.confidence * 1.5)) / k;
        }

        context.beginPath();
        context.moveTo(s.x, s.y);
        context.lineTo(t.x, t.y);
        context.stroke();
    }

    const radius = CONFIG.nodeRadius;
    const pi2 = 2 * Math.PI;

    for (const node of state.nodes) {
        if (node.x < viewport.minX - 10 || node.x > viewport.maxX + 10 ||
            node.y < viewport.minY - 10 || node.y > viewport.maxY + 10) {
            continue;
        }

        const isHovered = (state.hoveredNode === node);
        const dist = state.hoverDistances.has(node.id) ? state.hoverDistances.get(node.id) : Infinity;

        let opacity = 1.0;
        if (state.hoveredNode) {
            if (isHovered) {
                opacity = 1.0;
            } else if (dist === Infinity) {
                opacity = 0.05;
            } else {
                opacity = Math.max(0.05, 1.0 - (dist * state.fadeCoeff));
            }
        }

        const isActiveFilter = state.searchQuery || state.semanticChainsText;
        if (isActiveFilter) {
            if (!node._match && !isHovered) opacity *= 0.1;
        }

        context.beginPath();
        context.arc(node.x, node.y, radius, 0, pi2);
        context.fillStyle = node.color;

        if (opacity < 1) {
            context.globalAlpha = opacity;
            context.fill();
            context.globalAlpha = 1.0;
        } else {
            context.fill();
        }

        if (isHovered || (state.searchQuery && node._match)) {
            context.strokeStyle = "#fff";
            context.lineWidth = 2 / k;
            context.stroke();

            context.beginPath();
            context.arc(node.x, node.y, radius + 4 / k, 0, pi2);
            context.strokeStyle = `rgba(0, 229, 255, 0.6)`;
            context.lineWidth = 1 / k;
            context.stroke();
        }

        if (state.showLabels && k > 0.6 && opacity > 0.4) {
            context.font = `${8 / k}px Inter, sans-serif`;
            context.fillStyle = `rgba(240, 240, 245, ${opacity * 0.8})`;
            let text = node.text;
            if (text.length > 20) text = text.substring(0, 20) + "...";
            context.fillText(text, node.x + 8 / k, node.y + 3 / k);
        } else if (isHovered) {
            context.font = `bold ${10 / k}px Inter, sans-serif`;
            context.fillStyle = "#fff";
            context.fillText(node.text.substring(0, 40), node.x + 10 / k, node.y + 4 / k);
        }
    }

    context.restore();
}

function dragSubject(event) {
    const [x, y] = d3.pointer(event);
    const tx = state.transform.invertX(x);
    const ty = state.transform.invertY(y);

    let found = null;
    let minDistSq = Infinity;
    const hitRadius = Math.max((CONFIG.nodeRadius * 4) / state.transform.k, CONFIG.nodeRadius * 1.5);
    const hitRadiusSq = hitRadius * hitRadius;

    for (let i = state.nodes.length - 1; i >= 0; i--) {
        const n = state.nodes[i];
        const dx = tx - n.x;
        const dy = ty - n.y;
        const distSq = dx * dx + dy * dy;

        if (distSq < hitRadiusSq && distSq < minDistSq) {
            found = n;
            minDistSq = distSq;
        }
    }
    return found;
}

function dragstarted(event) {
    if (!event.active && state.isPhysicsActive) {
        simulationRef.alphaTarget(0.01).restart();
    }
    event.subject.fx = event.subject.x;
    event.subject.fy = event.subject.y;
    state.draggedNode = event.subject;
}

function dragged(event) {
    event.subject.fx = event.x;
    event.subject.fy = event.y;
    if (!state.isPhysicsActive) render();
}

function dragended(event) {
    if (!event.active && state.isPhysicsActive) simulationRef.alphaTarget(0);
    event.subject.fx = null;
    event.subject.fy = null;
    state.draggedNode = null;
}

// --- BOOTSTRAP ---
async function loadGraph() {
    const response = await fetch('/api/data');
    if (!response.ok) throw new Error(`Failed to fetch graph data`);
    const data = await response.json();
    initVis(data);
}

function setImportStatus(message, isError = false) {
    const statusEl = document.getElementById("import-status");
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.style.color = isError ? "#ff4a4a" : "";
}

function setSearchStatus(message, isError = false) {
    const statusEl = document.getElementById("search-status");
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.style.color = isError ? "#ff4a4a" : "";
}

function renderSearchResults(chains) {
    const pre = document.getElementById("search-results");
    if (!pre) return;
    if (!Array.isArray(chains) || chains.length === 0) {
        pre.classList.add('hidden');
        return;
    }
    pre.classList.remove('hidden');
    pre.textContent = chains.map((chain, index) => `${index + 1}. ${chain}`).join("\n");
}

async function runSemanticSearch() {
    const queryInput = document.getElementById("semantic-query");
    const query = queryInput.value.trim();
    if (!query) {
        setSearchStatus("Enter a query first.", true);
        renderSearchResults([]);
        state.semanticChainsText = "";
        updateMatches();
        if (!state.isPhysicsActive) render();
        return;
    }

    setSearchStatus("Running memory.search...");
    const maxDepth = parseInt(document.getElementById("param-depth")?.value) || undefined;
    const maxStartFacts = parseInt(document.getElementById("param-start")?.value) || undefined;
    const maxChains = parseInt(document.getElementById("param-chains")?.value) || undefined;

    const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, options: { maxDepth, maxStartFacts, maxChains } }),
    });
    const payload = await response.json();
    if (!response.ok) {
        setSearchStatus(payload?.error || "Search failed.", true);
        renderSearchResults([]);
        state.semanticChainsText = "";
        updateMatches();
        if (!state.isPhysicsActive) render();
        return;
    }

    const chains = Array.isArray(payload?.chains) ? payload.chains : [];
    setSearchStatus(`Found ${chains.length} chain(s).`);
    renderSearchResults(chains);
    state.semanticChainsText = chains.join("\n");
    updateMatches();
    if (!state.isPhysicsActive) render();
}

async function uploadSelectedDoc() {
    const fileInput = document.getElementById("doc-file");
    if (!fileInput.files || fileInput.files.length === 0) {
        setImportStatus("Select a .md or .txt file first.", true);
        return;
    }

    const file = fileInput.files[0];
    const lower = file.name.toLowerCase();
    if (!(lower.endsWith(".md") || lower.endsWith(".txt"))) {
        setImportStatus("Only .md/.txt files are supported.", true);
        return;
    }

    setImportStatus("Uploading and importing document...");
    const text = await file.text();

    const response = await fetch("/api/add-doc", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, content: text }),
    });
    const payload = await response.json();
    if (!response.ok) {
        setImportStatus(payload?.error || "Failed to import document.", true);
        return;
    }

    const result = payload?.result;
    const warnings = Array.isArray(result?.warnings) && result.warnings.length > 0
        ? `\nWarnings: ${result.warnings.join(" | ")}`
        : "";
    setImportStatus(
        `Imported ${result.documentFactCount} facts, ${result.totalLinksAdded} links.${warnings}`
    );
    await loadGraph();
    fileInput.value = "";
}

async function main() {
    try {
        await loadGraph();
    } catch (err) {
        console.error("Failed to load data", err);
    }

    const importButton = document.getElementById("import-doc");
    if (importButton) {
        importButton.addEventListener("click", () => {
            uploadSelectedDoc().catch((err) => {
                console.error("Import failed", err);
                setImportStatus(err.message || "Import failed.", true);
            });
        });
    }

    const runSearchButton = document.getElementById("run-search");
    if (runSearchButton) {
        runSearchButton.addEventListener("click", () => {
            runSemanticSearch().catch((err) => {
                console.error("Search failed", err);
                setSearchStatus(err.message || "Search failed.", true);
            });
        });
    }

    const semanticQuery = document.getElementById("semantic-query");
    if (semanticQuery) {
        semanticQuery.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            runSemanticSearch().catch((err) => {
                console.error("Search failed", err);
                setSearchStatus(err.message || "Search failed.", true);
            });
        });
        semanticQuery.addEventListener("input", (e) => {
            if (e.target.value.trim() === "") {
                state.semanticChainsText = "";
                updateMatches();
                if (!state.isPhysicsActive) render();
                renderSearchResults([]);
                setSearchStatus("");
            }
        });
    }

    const copySearchBtn = document.getElementById("copy-search");
    if (copySearchBtn) {
        copySearchBtn.addEventListener("click", () => {
            const textToCopy = state.semanticChainsText;
            if (textToCopy) {
                navigator.clipboard.writeText(textToCopy).then(() => {
                    const originalTitle = copySearchBtn.title;
                    copySearchBtn.title = "Copied!";
                    setTimeout(() => copySearchBtn.title = originalTitle, 2000);
                });
            }
        });
    }

    const searchInput = document.getElementById("search-input");
    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            state.searchQuery = e.target.value.toLowerCase();
            updateMatches();
            if (!state.isPhysicsActive) render();
        });
    }

    const fadeCoeffInput = document.getElementById("fade-coeff");
    const fadeCoeffVal = document.getElementById("fade-coeff-val");
    if (fadeCoeffInput && fadeCoeffVal) {
        fadeCoeffInput.addEventListener("input", (e) => {
            state.fadeCoeff = parseFloat(e.target.value);
            fadeCoeffVal.textContent = state.fadeCoeff.toFixed(2);
            requestAnimationFrame(render);
        });
    }

    const toggleSim = document.getElementById("toggle-sim");
    if (toggleSim) {
        toggleSim.addEventListener("change", (e) => {
            state.isPhysicsActive = e.target.checked;
            if (state.isPhysicsActive && simulationRef) {
                simulationRef.alpha(0.1).restart();
            } else if (simulationRef) {
                simulationRef.stop();
                render();
            }
        });
    }

    const showLabels = document.getElementById("show-labels");
    if (showLabels) {
        showLabels.addEventListener("change", (e) => {
            state.showLabels = e.target.checked;
            requestAnimationFrame(render);
        });
    }
}

// UI Helpers
function showTooltip(event, d) {
    tooltip.classed("hidden", false)
        .html(`
            <span class="tooltip-id">ID: ${d.id.substring(0, 10)}...</span>
            <div class="tooltip-title">${d.text}</div>
            <div class="tooltip-meta">
                <span class="tooltip-topics">${d.topics ? d.topics.join(", ") : "UNCLASSIFIED"}</span>
                <span class="tooltip-conf">${(d.confidence * 100).toFixed(0)}% CONF</span>
            </div>
        `);
}

function hideTooltip() {
    tooltip.classed("hidden", true);
}

main();