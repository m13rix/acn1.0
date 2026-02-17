// app.js

// Configuration
const CONFIG = {
    similarityThreshold: 0.5, // Minimum similarity to create a force link
    maxSimilarityLinks: 5,   // Max similar neighbors per node to link
    colors: d3.schemeTableau10,
    forceStrength: {
        explicit: 0.8,
        semantic: 0.2, // Weaker force for semantic similarity
        charge: -200,
        collide: 30
    },
    layout: {
        anchorStrengthExisting: 0.08,
        anchorStrengthNew: 0.015,
        alphaStartStable: 0.08,
        alphaStartFresh: 0.22,
        alphaMin: 0.03,
        alphaDecay: 0.12,
        velocityDecay: 0.6,
    }
};

// State
let state = {
    nodes: [],
    links: [],
    simLinks: [],
    width: window.innerWidth,
    height: window.innerHeight,
    transform: d3.zoomIdentity
};
let simulationRef = null;
let nodePositionCache = new Map();

// Elements
const container = d3.select("#universe");
const svg = container.append("svg")
    .attr("width", "100%")
    .attr("height", "100%")
    .style("background-color", "var(--bg-color)");

const g = svg.append("g");
const linkGroup = g.append("g").attr("class", "links");
const nodeGroup = g.append("g").attr("class", "nodes");
const labelGroup = g.append("g").attr("class", "labels");

// Tooltip
const tooltip = d3.select("#tooltip");

// --- UTILS ---

function cosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB || vecA.length !== vecB.length) return 0;
    let dot = 0;
    let magA = 0;
    let magB = 0;
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

// --- DATA PROCESSING ---

function processData(data) {
    const rawNodes = data.nodes;
    const rawLinks = data.links;

    // Create a map for quick lookup
    const nodeMap = new Map(rawNodes.map(n => [n.id, n]));

    // 1. Process Explicit Links (Database)
    const links = rawLinks.map(l => ({
        source: l.source,
        target: l.target,
        type: "explicit",
        relation: l.relation,
        confidence: l.confidence
    })).filter(l => nodeMap.has(l.source) && nodeMap.has(l.target));

    // 2. Generate Semantic Links (Similarity)
    if (rawNodes.length < 2000) {
        console.time("Similarity Calculation");
        // Simple O(N^2) for small datasets
        const simLinks = [];
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

            for (const c of candidates) {
                simLinks.push({
                    source: a.id,
                    target: c.id,
                    type: "semantic",
                    confidence: c.sim
                });
            }
        }
        console.timeEnd("Similarity Calculation");

        // Process Sibling Links (Multi-link handling)
        const siblings = {};
        links.forEach(l => {
            const sid = l.source;
            const tid = l.target;
            // Sort IDs to group A->B and B->A together
            const pairId = sid < tid ? `${sid}-${tid}` : `${tid}-${sid}`;
            if (!siblings[pairId]) siblings[pairId] = [];
            siblings[pairId].push(l);
        });

        Object.values(siblings).forEach(group => {
            const count = group.length;
            group.forEach((l, i) => {
                l.siblingIndex = i;
                l.siblingCount = count;
            });
        });

        return { nodes: rawNodes, links, simLinks };
    }

    return { nodes: rawNodes, links, simLinks: [] };
}

// --- VISUALIZATION ---

function initVis(data) {
    snapshotNodePositions(state.nodes);
    if (simulationRef) {
        simulationRef.stop();
    }
    linkGroup.selectAll("*").remove();
    nodeGroup.selectAll("*").remove();
    labelGroup.selectAll("*").remove();

    // Update Stats
    d3.select("#fact-count").text(`${data.nodes.length} FACTS`);
    d3.select("#link-count").text(`${data.links.length} LINKS`);

    const { nodes, links, simLinks } = processData(data);
    state.nodes = nodes;
    state.links = links;

    let reusedPositions = 0;
    const centerX = state.width / 2;
    const centerY = state.height / 2;
    for (const node of nodes) {
        const cached = nodePositionCache.get(node.id);
        if (cached) {
            node.x = cached.x;
            node.y = cached.y;
            node.vx = 0;
            node.vy = 0;
            node._isNew = false;
            reusedPositions += 1;
        } else {
            const start = getDeterministicStartPosition(node.id, centerX, centerY);
            node.x = start.x;
            node.y = start.y;
            node.vx = 0;
            node.vy = 0;
            node._isNew = true;
        }
        node._anchorX = node.x;
        node._anchorY = node.y;
    }
    const stableRatio = nodes.length > 0 ? (reusedPositions / nodes.length) : 0;

    // Combined links for simulation
    const allLinks = [...links, ...simLinks];

    // --- SIMULATION ---
    const simulation = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(allLinks).id(d => d.id).strength(l => {
            return l.type === 'explicit' ? 0.3 : (l.confidence * 0.5);
        }))
        .force("charge", d3.forceManyBody().strength(-90))
        .force("center", d3.forceCenter(state.width / 2, state.height / 2))
        .force("collide", d3.forceCollide().radius(20).iterations(2))
        .force("anchorX", d3.forceX(d => d._anchorX).strength(d => d._isNew ? CONFIG.layout.anchorStrengthNew : CONFIG.layout.anchorStrengthExisting))
        .force("anchorY", d3.forceY(d => d._anchorY).strength(d => d._isNew ? CONFIG.layout.anchorStrengthNew : CONFIG.layout.anchorStrengthExisting))
        .alpha(stableRatio > 0.5 ? CONFIG.layout.alphaStartStable : CONFIG.layout.alphaStartFresh)
        .alphaMin(CONFIG.layout.alphaMin)
        .alphaDecay(CONFIG.layout.alphaDecay)
        .velocityDecay(CONFIG.layout.velocityDecay);
    simulationRef = simulation;

    // --- RENDERING ---

    // Links: Group per link for layering (Ghost + Visible)
    const linkContainer = linkGroup.selectAll("g.link")
        .data(links)
        .join("g")
        .attr("class", "link");

    // Replace line with path for curvature
    // Ghost path for hit testing
    const ghostLinks = linkContainer.append("path")
        .attr("fill", "none")
        .attr("stroke", "transparent")
        .attr("stroke-width", 10)
        .style("cursor", "pointer")
        .on("mouseover", (event, d) => showLinkTooltip(event, d))
        .on("mouseout", hideTooltip);

    // Visible path
    const visibleLinks = linkContainer.append("path")
        .attr("fill", "none")
        .attr("stroke", "var(--link-color)")
        .attr("stroke-opacity", 0.6)
        .attr("stroke-width", d => Math.max(1, d.confidence * 2))
        .style("pointer-events", "none");

    // Nodes
    const colorScale = d3.scaleOrdinal(CONFIG.colors);

    const nodeElements = nodeGroup.selectAll("g")
        .data(nodes)
        .join("g")
        .call(d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended));

    // Node Circles
    const circles = nodeElements.append("circle")
        .attr("r", 6)
        .attr("fill", d => {
            const topic = d.topics && d.topics.length > 0 ? d.topics[0] : "unknown";
            return colorScale(topic);
        })
        .attr("stroke", "#fff")
        .attr("stroke-width", 1.5)
        .style("cursor", "pointer")
        .on("mouseover", (event, d) => showTooltip(event, d))
        .on("mouseout", hideTooltip);

    // Node Labels
    const labels = labelGroup.selectAll("text")
        .data(nodes)
        .join("text")
        .text(d => d.text.length > 20 ? d.text.substring(0, 20) + "..." : d.text)
        .attr("x", 10)
        .attr("y", 4)
        .attr("font-size", "10px")
        .attr("fill", "var(--text-secondary)")
        .style("pointer-events", "none")
        .style("opacity", 0.8);

    // Link Curve Path Generator
    const linkPath = (d) => {
        const dx = d.target.x - d.source.x;
        const dy = d.target.y - d.source.y;

        // If single link, straight line
        if (!d.siblingCount || d.siblingCount <= 1) {
            return `M${d.source.x},${d.source.y}L${d.target.x},${d.target.y}`;
        }

        // Quadratic Bezier
        const mx = (d.source.x + d.target.x) / 2;
        const my = (d.source.y + d.target.y) / 2;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len === 0) return "";

        const nx = -dy / len;
        const ny = dx / len;

        // Offset
        // Prevent overlap by spreading them out. 
        // 2 links: -10, +10
        // 3 links: -20, 0, 20
        const spacing = 20;
        const offset = (d.siblingIndex - (d.siblingCount - 1) / 2) * spacing;

        const cx = mx + nx * offset;
        const cy = my + ny * offset;

        return `M${d.source.x},${d.source.y}Q${cx},${cy} ${d.target.x},${d.target.y}`;
    };

    // --- TICK ---
    simulation.on("tick", () => {
        ghostLinks.attr("d", linkPath);
        visibleLinks.attr("d", linkPath);

        nodeElements
            .attr("transform", d => `translate(${d.x},${d.y})`);

        labels
            .attr("transform", d => `translate(${d.x},${d.y})`);
    });
    simulation.on("end", () => {
        snapshotNodePositions(nodes);
    });

    // --- ZOOM ---
    const updateScales = (k) => {
        const invK = 1 / k;
        circles.attr("r", 6 * invK).attr("stroke-width", 1.5 * invK);
        labels.attr("font-size", (10 * invK) + "px").attr("x", 10 * invK).attr("y", 4 * invK);
        ghostLinks.attr("stroke-width", 10 * invK);
        visibleLinks.attr("stroke-width", d => Math.max(1, d.confidence * 2) * invK);
    };

    const zoom = d3.zoom()
        .scaleExtent([0.1, 10])
        .on("zoom", (event) => {
            const { transform } = event;
            g.attr("transform", transform);
            state.transform = transform;
            updateScales(transform.k);
        });

    svg.call(zoom);
    svg.call(zoom.transform, state.transform || d3.zoomIdentity);

    // --- CONTROLS ---
    d3.select("#toggle-sim").on("click", function () {
        if (this.innerText === "Pause") {
            simulation.stop();
            this.innerText = "Resume";
        } else {
            simulation.restart();
            this.innerText = "Pause";
        }
    });

    d3.select("#show-labels").on("change", function () {
        labels.classed("hidden", !this.checked);
        if (!this.checked) labels.style("opacity", 0);
        else labels.style("opacity", 0.8);
    });

    d3.select("#search-input").on("input", function () {
        const query = this.value.toLowerCase();
        if (!query) {
            nodeElements.style("opacity", 1);
            visibleLinks.style("opacity", 0.6);
            return;
        }

        const matchedIds = new Set();
        nodeElements.style("opacity", d => {
            const match = d.text.toLowerCase().includes(query) ||
                (d.topics && d.topics.some(t => t.toLowerCase().includes(query)));
            if (match) matchedIds.add(d.id);
            return match ? 1 : 0.1;
        });

        visibleLinks.style("opacity", l =>
            (matchedIds.has(l.source.id) && matchedIds.has(l.target.id)) ? 0.6 : 0.05
        );
    });

    // Drag functions
    function dragstarted(event, d) {
        if (!event.active) simulation.alphaTarget(0.15).restart();
        d.fx = d.x;
        d.fy = d.y;
    }

    function dragged(event, d) {
        d.fx = event.x;
        d.fy = event.y;
    }

    function dragended(event, d) {
        if (!event.active) simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
    }
}

// --- BOOTSTRAP ---
async function loadGraph() {
    const response = await fetch('/api/data');
    if (!response.ok) {
        throw new Error(`Failed to fetch graph data: ${response.status}`);
    }
    const data = await response.json();
    initVis(data);
}

function setImportStatus(message, isError = false) {
    const statusEl = document.getElementById("import-status");
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.style.color = isError ? "#ff7070" : "";
}

function setSearchStatus(message, isError = false) {
    const statusEl = document.getElementById("search-status");
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.style.color = isError ? "#ff7070" : "";
}

function renderSearchResults(chains) {
    const pre = document.getElementById("search-results");
    if (!(pre instanceof HTMLElement)) return;
    if (!Array.isArray(chains) || chains.length === 0) {
        pre.textContent = "No chains found.";
        return;
    }
    pre.textContent = chains.map((chain, index) => `${index + 1}. ${chain}`).join("\n");
}

async function runSemanticSearch() {
    const queryInput = document.getElementById("semantic-query");
    if (!(queryInput instanceof HTMLInputElement)) return;
    const query = queryInput.value.trim();
    if (!query) {
        setSearchStatus("Enter a query first.", true);
        renderSearchResults([]);
        return;
    }

    setSearchStatus("Running memory.search...");
    const response = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query }),
    });
    const payload = await response.json();
    if (!response.ok) {
        setSearchStatus(payload?.error || "Search failed.", true);
        renderSearchResults([]);
        return;
    }

    const chains = Array.isArray(payload?.chains) ? payload.chains : [];
    setSearchStatus(`Found ${chains.length} chain(s).`);
    renderSearchResults(chains);
}

async function uploadSelectedDoc() {
    const fileInput = document.getElementById("doc-file");
    if (!(fileInput instanceof HTMLInputElement) || !fileInput.files || fileInput.files.length === 0) {
        setImportStatus("Select a .md or .txt file first.", true);
        return;
    }

    const file = fileInput.files[0];
    if (!file) return;
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
                setImportStatus(err instanceof Error ? err.message : "Import failed.", true);
            });
        });
    }

    const runSearchButton = document.getElementById("run-search");
    if (runSearchButton) {
        runSearchButton.addEventListener("click", () => {
            runSemanticSearch().catch((err) => {
                console.error("Search failed", err);
                setSearchStatus(err instanceof Error ? err.message : "Search failed.", true);
            });
        });
    }

    const semanticQuery = document.getElementById("semantic-query");
    if (semanticQuery instanceof HTMLInputElement) {
        semanticQuery.addEventListener("keydown", (event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            runSemanticSearch().catch((err) => {
                console.error("Search failed", err);
                setSearchStatus(err instanceof Error ? err.message : "Search failed.", true);
            });
        });
    }
}

// --- UI HELPERS ---
function showTooltip(event, d) {
    tooltip.classed("hidden", false)
        .style("left", (event.pageX + 15) + "px")
        .style("top", (event.pageY + 15) + "px")
        .html(`
            <span class="tooltip-id">ID: ${d.id.substring(0, 8)}...</span>
            <div style="font-weight:bold; margin-bottom:5px;">${d.text}</div>
            <div style="color:var(--accent); font-size:10px;">${d.topics ? d.topics.join(", ") : ""}</div>
            <div style="color:#666; font-size:9px; margin-top:5px;">Confidence: ${(d.confidence * 100).toFixed(0)}%</div>
        `);
}

function showLinkTooltip(event, d) {
    // d is the link object
    tooltip.classed("hidden", false)
        .style("left", (event.pageX + 15) + "px")
        .style("top", (event.pageY + 15) + "px")
        .html(`
            <span class="tooltip-id">LINK</span>
            <div style="font-weight:bold; color:var(--accent); margin-bottom:5px;">${d.relation.toUpperCase()}</div>
            <div style="font-size:10px; color:var(--text-primary); margin-bottom:5px;">
                ${d.source.text.substring(0, 20)}... <span style="color:var(--text-secondary)">→</span> ${d.target.text.substring(0, 20)}...
            </div>
            <div style="color:#666; font-size:9px;">Confidence: ${(d.confidence * 100).toFixed(0)}%</div>
        `);
}

function hideTooltip() {
    tooltip.classed("hidden", true);
}

main();
