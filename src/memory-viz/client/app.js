const CONFIG = {
    similarityThreshold: 0.5,
    maxSimilarityLinks: 5,
    nodeRadius: 3,
    layout: {
        alphaDecay: 0.05,
        velocityDecay: 0.6,
    },
    colors: {
        "en:constituency": "#00e5ff",
        "en:ud": "#00ff9d",
        "ru:ud": "#ffaa00",
        "default": "#8a8a9e",
    },
};

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
    fadeCoeff: 0.3,
    highlightFactIds: new Set(),
    lastSearchResult: null,
    namespace: "global_memory_v2",
    lastDebugTrace: null,
    activeDebugSession: null,
    searchCategories: [],
    searchCategoryMultipliers: {},
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
const tooltip = d3.select("#tooltip");

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

function buildAdjacencyList(nodes, links) {
    adjacencyList.clear();
    for (const node of nodes) adjacencyList.set(node.id, new Set());
    for (const link of links) {
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        if (adjacencyList.has(sourceId)) adjacencyList.get(sourceId).add(targetId);
        if (adjacencyList.has(targetId)) adjacencyList.get(targetId).add(sourceId);
    }
}

function phraseCountText(node) {
    const counts = node.phraseCounts || { np: 0, vp: 0, adjp: 0 };
    return `NP ${counts.np} | VP ${counts.vp} | ADJP ${counts.adjp}`;
}

function updateMatches() {
    state.nodes.forEach((node) => {
        let filterMatch = true;
        if (state.searchQuery) {
            const meta = `${node.text} ${node.language || ""} ${node.parserMode || ""} ${phraseCountText(node)}`.toLowerCase();
            filterMatch = meta.includes(state.searchQuery);
        }

        let searchMatch = true;
        if (state.highlightFactIds.size > 0 || state.semanticChainsText) {
            searchMatch = state.highlightFactIds.has(node.id) || state.semanticChainsText.includes(node.text);
        }

        node._match = filterMatch && searchMatch;
    });
}

function processData(data) {
    const rawNodes = Array.isArray(data?.nodes) ? data.nodes : [];
    const rawLinks = Array.isArray(data?.links) ? data.links : [];
    const nodeMap = new Map(rawNodes.map((node) => [node.id, node]));

    const links = rawLinks.map((link) => ({
        source: link.source,
        target: link.target,
        type: "explicit",
        relation: link.relation,
        confidence: link.confidence,
    })).filter((link) => nodeMap.has(link.source) && nodeMap.has(link.target));

    const simLinks = [];
    if (rawNodes.length < 2000) {
        for (let i = 0; i < rawNodes.length; i++) {
            const left = rawNodes[i];
            if (!left.embedding || left.embedding.length === 0) continue;

            const candidates = [];
            for (let j = i + 1; j < rawNodes.length; j++) {
                const right = rawNodes[j];
                if (!right.embedding || right.embedding.length === 0) continue;

                const similarity = cosineSimilarity(left.embedding, right.embedding);
                if (similarity > CONFIG.similarityThreshold) {
                    candidates.push({ id: right.id, similarity });
                }
            }

            candidates.sort((a, b) => b.similarity - a.similarity);
            for (const candidate of candidates.slice(0, CONFIG.maxSimilarityLinks)) {
                simLinks.push({
                    source: left.id,
                    target: candidate.id,
                    type: "semantic",
                    confidence: candidate.similarity,
                });
            }
        }
    }

    return { nodes: rawNodes, links, simLinks };
}

function colorForNode(node) {
    const key = `${node.language || "unknown"}:${node.parserMode || "unknown"}`;
    return CONFIG.colors[key] || CONFIG.colors.default;
}

function initVis(data) {
    snapshotNodePositions(state.nodes);
    if (simulationRef) simulationRef.stop();

    state.namespace = data?.namespace || state.namespace;
    const namespaceBadge = document.getElementById("namespace-badge");
    if (namespaceBadge) {
        namespaceBadge.textContent = state.namespace;
    }

    const { nodes, links, simLinks } = processData(data);
    state.nodes = nodes;
    state.links = links;
    state.simLinks = simLinks;

    d3.select("#fact-count").text(nodes.length);
    d3.select("#link-count").text(links.length);
    renderRuntimeStatus(data?.runtimeStatus || null);

    const allLinks = [...links, ...simLinks];
    buildAdjacencyList(nodes, allLinks);

    const centerX = state.width / 2;
    const centerY = state.height / 2;

    for (const node of nodes) {
        const cached = nodePositionCache.get(node.id);
        if (cached) {
            node.x = cached.x;
            node.y = cached.y;
        } else {
            const start = getDeterministicStartPosition(node.id, centerX, centerY);
            node.x = start.x;
            node.y = start.y;
        }
        node.vx = 0;
        node.vy = 0;
        node.color = colorForNode(node);
    }

    updateMatches();

    simulationRef = d3.forceSimulation(nodes)
        .force("link", d3.forceLink(allLinks).id((d) => d.id).distance((d) => d.type === "explicit" ? 80 : 120).strength((link) => {
            return link.type === "explicit" ? 0.8 : (link.confidence * 0.05);
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
        const hitRadius = Math.max((CONFIG.nodeRadius * 4) / state.transform.k, CONFIG.nodeRadius * 1.5);
        const hitRadiusSq = hitRadius * hitRadius;

        for (let i = nodes.length - 1; i >= 0; i--) {
            const node = nodes[i];
            const dx = tx - node.x;
            const dy = ty - node.y;
            const distSq = dx * dx + dy * dy;

            if (distSq < hitRadiusSq && distSq < minDistSq) {
                found = node;
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
                    if (dist >= 10) continue;
                    const neighbors = adjacencyList.get(currentId);
                    if (!neighbors) continue;
                    for (const neighborId of neighbors) {
                        if (!state.hoverDistances.has(neighborId)) {
                            state.hoverDistances.set(neighborId, dist + 1);
                            queue.push(neighborId);
                        }
                    }
                }
            } else {
                canvas.style("cursor", "grab");
                hideTooltip();
            }
            requestAnimationFrame(render);
        } else if (found) {
            tooltip.style("left", `${event.pageX + 15}px`)
                .style("top", `${event.pageY + 15}px`);
        }
    });

    render();
}

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
        maxY: state.transform.invertY(state.height),
    };

    context.lineWidth = 1.0 / k;
    for (const link of state.links) {
        const source = link.source;
        const target = link.target;
        const isHovered = state.hoveredNode === source || state.hoveredNode === target;
        const isActiveFilter = state.searchQuery || state.semanticChainsText || state.highlightFactIds.size > 0;
        if (!isHovered && isActiveFilter && !source._match && !target._match) continue;

        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distSq = dx * dx + dy * dy;
        if (!isHovered && distSq > 250000) continue;

        const dist = Math.sqrt(distSq);
        let baseOpacity = Math.max(0.01, 1.0 - (dist / 400));
        if (distSq > 10000) baseOpacity *= 0.5;

        if (state.hoveredNode) {
            const distSource = state.hoverDistances.has(source.id) ? state.hoverDistances.get(source.id) : Infinity;
            const distTarget = state.hoverDistances.has(target.id) ? state.hoverDistances.get(target.id) : Infinity;
            const linkDist = Math.max(distSource, distTarget);

            if (isHovered) {
                baseOpacity = 0.8;
            } else if (linkDist === Infinity) {
                baseOpacity *= 0.05;
            } else {
                baseOpacity *= Math.max(0.05, 1.0 - (linkDist * state.fadeCoeff));
            }
        }

        if (baseOpacity < 0.02 && !isHovered) continue;

        context.strokeStyle = link.type === "explicit"
            ? `rgba(0, 229, 255, ${baseOpacity})`
            : `rgba(138, 138, 158, ${baseOpacity * 0.4})`;
        context.lineWidth = isHovered
            ? 2.0 / k
            : (Math.max(0.5, link.confidence * 1.5)) / k;

        if (isHovered) {
            context.strokeStyle = "rgba(255, 255, 255, 0.9)";
        }

        context.beginPath();
        context.moveTo(source.x, source.y);
        context.lineTo(target.x, target.y);
        context.stroke();
    }

    const radius = CONFIG.nodeRadius;
    const pi2 = 2 * Math.PI;

    for (const node of state.nodes) {
        if (node.x < viewport.minX - 10 || node.x > viewport.maxX + 10 ||
            node.y < viewport.minY - 10 || node.y > viewport.maxY + 10) {
            continue;
        }

        const isHovered = state.hoveredNode === node;
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

        const isActiveFilter = state.searchQuery || state.semanticChainsText || state.highlightFactIds.size > 0;
        if (isActiveFilter && !node._match && !isHovered) {
            opacity *= 0.1;
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

        if (isHovered || state.highlightFactIds.has(node.id) || (state.searchQuery && node._match)) {
            context.strokeStyle = "#fff";
            context.lineWidth = 2 / k;
            context.stroke();

            context.beginPath();
            context.arc(node.x, node.y, radius + 4 / k, 0, pi2);
            context.strokeStyle = "rgba(0, 229, 255, 0.6)";
            context.lineWidth = 1 / k;
            context.stroke();
        }

        if (state.showLabels && k > 0.6 && opacity > 0.4) {
            context.font = `${8 / k}px Inter, sans-serif`;
            context.fillStyle = `rgba(240, 240, 245, ${opacity * 0.8})`;
            const label = node.text.length > 24 ? `${node.text.substring(0, 24)}...` : node.text;
            context.fillText(label, node.x + 8 / k, node.y + 3 / k);
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
        const node = state.nodes[i];
        const dx = tx - node.x;
        const dy = ty - node.y;
        const distSq = dx * dx + dy * dy;
        if (distSq < hitRadiusSq && distSq < minDistSq) {
            found = node;
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

async function loadGraph() {
    const agentName = getActiveAgentName();
    const query = agentName ? `?agentName=${encodeURIComponent(agentName)}` : "";
    const response = await fetch(`/api/data${query}`);
    if (!response.ok) throw new Error("Failed to fetch graph data");
    const data = await response.json();
    initVis(data);
}

function renderRuntimeStatus(runtimeStatus) {
    const queueCount = Number(runtimeStatus?.queue?.pendingJobs || 0);
    const notesSyncCount = Number(runtimeStatus?.notesSync?.pendingSettles || 0);
    d3.select("#queue-count").text(queueCount);
    d3.select("#notes-sync-count").text(notesSyncCount);
}

function setStatus(id, message, isError = false) {
    const element = document.getElementById(id);
    if (!element) return;
    element.textContent = message;
    element.style.color = isError ? "#ff4a4a" : "";
}

function isDebugEnabled() {
    return Boolean(document.getElementById("debug-enabled")?.checked);
}

function renderDebugTrace(trace) {
    const pre = document.getElementById("debug-output");
    if (!pre) return;
    state.lastDebugTrace = trace || null;
    if (!trace) {
        pre.className = "debug-output empty-state";
        pre.textContent = "No debug trace yet.";
        return;
    }

    pre.className = "debug-output";
    const header = [
        `operation: ${trace.operation || "unknown"}`,
        `startedAt: ${trace.startedAt || "n/a"}`,
        `finishedAt: ${trace.finishedAt || "n/a"}`,
        `durationMs: ${trace.durationMs ?? "n/a"}`,
        `success: ${trace.success ?? "n/a"}`,
        "",
    ];
    const events = Array.isArray(trace.events) ? trace.events : [];
    const body = events.map((event, index) => {
        const lines = [
            `[${index + 1}] +${event.atMs ?? "?"}ms  ${event.scope || "unknown"}  ${event.message || ""}`,
        ];
        if (event.data !== undefined) {
            try {
                lines.push(JSON.stringify(event.data, null, 2));
            } catch {
                lines.push(String(event.data));
            }
        }
        return lines.join("\n");
    });
    pre.textContent = [...header, ...body].join("\n");
    pre.scrollTop = pre.scrollHeight;
}

function createDebugSessionId(prefix) {
    const randomPart = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return `${prefix}-${randomPart}`;
}

function stopDebugPolling() {
    if (state.activeDebugSession?.abortController) {
        state.activeDebugSession.abortController.abort();
    }
    state.activeDebugSession = null;
}

async function pollDebugSession(sessionId, abortSignal) {
    let delayMs = 250;
    let notFoundCount = 0;
    while (!abortSignal.aborted) {
        try {
            const traceResponse = await fetch(`/api/debug-session/${encodeURIComponent(sessionId)}?since=0`, {
                signal: abortSignal,
            });
            if (traceResponse.status === 404) {
                notFoundCount += 1;
                if (notFoundCount <= 20) {
                    await new Promise((resolve) => setTimeout(resolve, 150));
                    continue;
                }
                return;
            }
            if (!traceResponse.ok) {
                throw new Error(`Debug polling failed with status ${traceResponse.status}`);
            }

            const payload = await traceResponse.json();
            notFoundCount = 0;
            if (payload?.trace) {
                renderDebugTrace(payload.trace);
            }
            if (payload?.done) {
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
            delayMs = Math.min(1000, delayMs + 100);
        } catch (error) {
            if (abortSignal.aborted) {
                return;
            }
            console.error("Debug polling error:", error);
            await new Promise((resolve) => setTimeout(resolve, 500));
        }
    }
}

function beginLiveDebug(operation) {
    stopDebugPolling();
    if (!isDebugEnabled()) {
        return null;
    }

    const sessionId = createDebugSessionId(operation);
    const abortController = new AbortController();
    state.activeDebugSession = { sessionId, abortController, operation };
    renderDebugTrace({
        operation,
        startedAt: new Date().toISOString(),
        events: [
            {
                atMs: 0,
                scope: "memory-viz.debug",
                message: "Live debug session created. Waiting for server events...",
            },
        ],
    });
    pollDebugSession(sessionId, abortController.signal)
        .catch((error) => {
            if (!abortController.signal.aborted) {
                console.error("Live debug session failed:", error);
            }
        })
        .finally(() => {
            if (state.activeDebugSession?.sessionId === sessionId) {
                state.activeDebugSession = null;
            }
        });
    return sessionId;
}

function renderSearchResults(chains) {
    const pre = document.getElementById("search-results");
    if (!pre) return;
    if (!Array.isArray(chains) || chains.length === 0) {
        pre.classList.add("hidden");
        pre.textContent = "";
        return;
    }
    pre.classList.remove("hidden");
    pre.textContent = chains.map((chain, index) => `${index + 1}. ${chain}`).join("\n");
}

function renderQueryPhrases(queryPhrases) {
    const container = document.getElementById("query-phrases");
    if (!container) return;
    if (!Array.isArray(queryPhrases) || queryPhrases.length === 0) {
        container.className = "chip-list empty-state";
        container.textContent = "No extracted NP / VP / ADJP phrases.";
        return;
    }

    container.className = "chip-list";
    container.innerHTML = queryPhrases.map((phrase) => `
        <div class="chip">
            <span class="chip-kind">${phrase.type.toUpperCase()}</span>
            <span>${escapeHtml(phrase.text)}</span>
            <span class="chip-weight">${Number(phrase.weight).toFixed(4)}</span>
        </div>
    `).join("");
}

function renderSeedFacts(seedFacts) {
    const container = document.getElementById("seed-facts");
    if (!container) return;
    if (!Array.isArray(seedFacts) || seedFacts.length === 0) {
        container.className = "list-panel empty-state";
        container.textContent = "No seed facts selected.";
        return;
    }

    container.className = "list-panel";
    container.innerHTML = seedFacts.map((seed) => `
        <div class="seed-row">
            <span class="seed-id">${escapeHtml(seed.factId)}</span>
            <span class="seed-score">${Number(seed.score).toFixed(4)}</span>
        </div>
    `).join("");
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function readNumberInput(id) {
    const value = document.getElementById(id)?.value;
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function readTrimmedInput(id) {
    const value = document.getElementById(id)?.value;
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
}

function getActiveAgentName() {
    return readTrimmedInput("search-agent-name");
}

// --- Categories Management ---

function addSearchCategory(name) {
    name = name.trim().toLowerCase();
    if (!name || state.searchCategories.includes(name)) return;
    state.searchCategories.push(name);
    renderSearchCategories();
}

function removeSearchCategory(name) {
    state.searchCategories = state.searchCategories.filter((c) => c !== name);
    delete state.searchCategoryMultipliers[name];
    renderSearchCategories();
}

function renderSearchCategories() {
    const tagsContainer = document.getElementById("search-categories-tags");
    const multContainer = document.getElementById("search-category-multipliers");
    if (!tagsContainer) return;

    if (state.searchCategories.length === 0) {
        tagsContainer.innerHTML = "";
        if (multContainer) multContainer.innerHTML = "";
        return;
    }

    tagsContainer.innerHTML = state.searchCategories.map((cat) => `
        <span class="tag-chip">
            ${escapeHtml(cat)}
            <span class="tag-remove" data-cat="${escapeHtml(cat)}">&times;</span>
        </span>
    `).join("");

    tagsContainer.querySelectorAll(".tag-remove").forEach((el) => {
        el.addEventListener("click", () => removeSearchCategory(el.dataset.cat));
    });

    if (multContainer) {
        multContainer.innerHTML = `
            <div class="multiplier-title">Category Multipliers</div>
            ${state.searchCategories.map((cat) => `
                <div class="multiplier-row">
                    <span class="mult-cat">${escapeHtml(cat)}</span>
                    <input type="number" class="mult-value" data-cat="${escapeHtml(cat)}"
                        value="${state.searchCategoryMultipliers[cat] ?? 1.0}"
                        step="0.1" min="0" max="5">
                </div>
            `).join("")}
        `;
        multContainer.querySelectorAll(".mult-value").forEach((input) => {
            input.addEventListener("change", () => {
                const cat = input.dataset.cat;
                const val = parseFloat(input.value);
                if (Number.isFinite(val)) {
                    state.searchCategoryMultipliers[cat] = val;
                }
            });
        });
    }
}

function buildSearchOptions() {
    const phraseAggregationMode = document.getElementById("param-aggregation")?.value || "max";
    const candidateMode = document.getElementById("param-candidate-mode")?.value || "top-k";
    const includeUncategorized = document.getElementById("search-include-uncategorized")?.checked ?? true;

    const categories = state.searchCategories.length > 0 ? state.searchCategories : undefined;
    const multipliers = Object.keys(state.searchCategoryMultipliers).length > 0
        ? { ...state.searchCategoryMultipliers }
        : undefined;

    return {
        maxDepth: readNumberInput("param-depth"),
        beamWidth: readNumberInput("param-beam"),
        maxChains: readNumberInput("param-chains"),
        overallEmbeddingWeight: readNumberInput("param-overall-weight"),
        phraseAggregationMode,
        agentName: getActiveAgentName(),
        categories,
        includeUncategorized,
        ...(multipliers ? { categoryMultipliers: multipliers } : {}),
        candidateSelection: {
            mode: candidateMode,
            topK: readNumberInput("param-top-k"),
            threshold: readNumberInput("param-threshold"),
            minCandidates: readNumberInput("param-range-min"),
            maxCandidates: readNumberInput("param-range-max"),
        },
    };
}

async function runSemanticSearch() {
    const query = document.getElementById("semantic-query")?.value?.trim() || "";
    if (!query) {
        setStatus("search-status", "Enter a query first.", true);
        renderSearchResults([]);
        renderQueryPhrases([]);
        renderSeedFacts([]);
        renderDebugTrace(null);
        state.semanticChainsText = "";
        state.highlightFactIds = new Set();
        state.lastSearchResult = null;
        updateMatches();
        if (!state.isPhysicsActive) render();
        return;
    }

    setStatus("search-status", "Running unified memory search...");
    const debugSessionId = beginLiveDebug("search");
    let response;
    let payload;
    try {
        response = await fetch("/api/search", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                query,
                options: buildSearchOptions(),
                debug: isDebugEnabled(),
                debugSessionId,
            }),
        });

        payload = await response.json();
    } catch (error) {
        stopDebugPolling();
        setStatus("search-status", error instanceof Error ? error.message : "Search failed.", true);
        return;
    }
    stopDebugPolling();
    if (!response.ok) {
        setStatus("search-status", payload?.error || "Search failed.", true);
        renderSearchResults([]);
        renderQueryPhrases([]);
        renderSeedFacts([]);
        renderDebugTrace(payload?.debug || null);
        state.semanticChainsText = "";
        state.highlightFactIds = new Set();
        state.lastSearchResult = null;
        updateMatches();
        if (!state.isPhysicsActive) render();
        return;
    }

    state.lastSearchResult = payload;
    const chains = Array.isArray(payload?.chains) ? payload.chains : [];
    const seedFacts = Array.isArray(payload?.seedFacts) ? payload.seedFacts : [];
    const queryPhrases = Array.isArray(payload?.queryPhrases) ? payload.queryPhrases : [];
    state.highlightFactIds = new Set(seedFacts.map((seed) => seed.factId));
    state.semanticChainsText = chains.join("\n");
    renderDebugTrace(payload?.debug || null);

    setStatus(
        "search-status",
        `Found ${chains.length} chain(s) | ${queryPhrases.length} weighted phrase(s) | ${seedFacts.length} seed fact(s) | ${payload?.surfacedFactIds?.length || 0} surfaced fact(s) | ${payload?.debug?.durationMs ?? "?"} ms.`
    );
    renderSearchResults(chains);
    renderQueryPhrases(queryPhrases);
    renderSeedFacts(seedFacts);
    updateMatches();
    if (!state.isPhysicsActive) render();
}

async function ingestText() {
    const text = document.getElementById("ingest-text")?.value?.trim() || "";
    const retrievalHints = (document.getElementById("ingest-hints")?.value || "")
        .split(/\r?\n/g)
        .map((line) => line.trim())
        .filter(Boolean);
    const exclusiveEnabled = Boolean(document.getElementById("ingest-exclusive-enabled")?.checked);
    const exclusiveToAgentName = exclusiveEnabled ? readTrimmedInput("ingest-agent-name") : undefined;

    if (!text) {
        setStatus("import-status", "Paste source text first.", true);
        return;
    }
    if (exclusiveEnabled && !exclusiveToAgentName) {
        setStatus("import-status", "Enter the exclusive agent name or disable exclusive mode.", true);
        return;
    }

    setStatus("import-status", "Queueing memory.add job...");
    const debugSessionId = beginLiveDebug("ingest");
    let response;
    let payload;
    try {
        response = await fetch("/api/ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text, retrievalHints, exclusiveToAgentName, debug: isDebugEnabled(), debugSessionId }),
        });

        payload = await response.json();
    } catch (error) {
        stopDebugPolling();
        setStatus("import-status", error instanceof Error ? error.message : "Queue add failed.", true);
        return;
    }
    stopDebugPolling();
    if (!response.ok) {
        setStatus("import-status", payload?.error || "Queue add failed.", true);
        renderDebugTrace(payload?.debug || null);
        return;
    }

    const result = payload?.result || {};
    renderDebugTrace(payload?.debug || null);
    setStatus(
        "import-status",
        `Queued job ${result.id || "unknown"} with ETA ${result.etaSeconds ?? "?"}s.`
    );
    await loadGraph();
}

async function migrateLegacyNamespace() {
    const sourceNamespace = document.getElementById("migration-source")?.value?.trim() || "global_memory";
    setStatus("migration-status", `Migrating "${sourceNamespace}" into the current V2 namespace...`);
    const debugSessionId = beginLiveDebug("migrate");

    let response;
    let payload;
    try {
        response = await fetch("/api/migrate-v1", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sourceNamespace, debug: isDebugEnabled(), debugSessionId }),
        });

        payload = await response.json();
    } catch (error) {
        stopDebugPolling();
        setStatus("migration-status", error instanceof Error ? error.message : "Migration failed.", true);
        return;
    }
    stopDebugPolling();
    if (!response.ok) {
        setStatus("migration-status", payload?.error || "Migration failed.", true);
        renderDebugTrace(payload?.debug || null);
        return;
    }

    const result = payload?.result || {};
    renderDebugTrace(payload?.debug || null);
    setStatus(
        "migration-status",
        `Migrated ${result.factCount || 0} fact(s) and ${result.linkCount || 0} link(s) from "${sourceNamespace}" in ${payload?.debug?.durationMs ?? "?"} ms.`
    );
    await loadGraph();
}

function showTooltip(event, node) {
    const scopeLabel = node.exclusiveToAgentName
        ? `exclusive to ${node.exclusiveToAgentName}`
        : "shared";
    const sourceLabel = node.sourceLabel || node.sourceId || "manual";
    tooltip.classed("hidden", false)
        .html(`
            <span class="tooltip-id">ID: ${escapeHtml(node.id.substring(0, 10))}...</span>
            <div class="tooltip-title">${escapeHtml(node.text)}</div>
            <div class="tooltip-meta" style="display:block;">
                <div class="tooltip-topics">${escapeHtml(`${node.language.toUpperCase()} | ${node.parserMode.toUpperCase()}`)}</div>
                <div class="tooltip-topics">${escapeHtml(phraseCountText(node))}</div>
                <div class="tooltip-conf">${escapeHtml(`${node.hintCount || 0} retrieval hint(s)`)}</div>
                <div class="tooltip-topics">${escapeHtml(`Source: ${sourceLabel}`)}</div>
                <div class="tooltip-topics">${escapeHtml(`Scope: ${scopeLabel}`)}</div>
            </div>
        `)
        .style("left", `${event.pageX + 15}px`)
        .style("top", `${event.pageY + 15}px`);
}

function hideTooltip() {
    tooltip.classed("hidden", true);
}

// --- Accordion ---

function initAccordion() {
    document.querySelectorAll(".accordion-header").forEach((header) => {
        header.addEventListener("click", () => {
            const section = header.closest(".accordion-section");
            if (!section) return;
            const isExpanded = section.classList.contains("expanded");
            const body = section.querySelector(".accordion-body");
            if (!body) return;

            if (isExpanded) {
                body.style.maxHeight = "0px";
                section.classList.remove("expanded");
            } else {
                section.classList.add("expanded");
                body.style.maxHeight = body.scrollHeight + "px";
            }
        });
    });
}

async function main() {
    try {
        await loadGraph();
    } catch (error) {
        console.error("Failed to load data", error);
    }

    initAccordion();

    document.getElementById("ingest-text-btn")?.addEventListener("click", () => {
        ingestText().catch((error) => {
            console.error("Ingest failed", error);
            setStatus("import-status", error?.message || "Ingest failed.", true);
        });
    });

    document.getElementById("refresh-graph")?.addEventListener("click", () => {
        loadGraph().catch((error) => {
            console.error("Refresh failed", error);
            setStatus("import-status", error?.message || "Refresh failed.", true);
        });
    });

    document.getElementById("run-search")?.addEventListener("click", () => {
        runSemanticSearch().catch((error) => {
            console.error("Search failed", error);
            setStatus("search-status", error?.message || "Search failed.", true);
        });
    });

    document.getElementById("run-migration")?.addEventListener("click", () => {
        migrateLegacyNamespace().catch((error) => {
            console.error("Migration failed", error);
            setStatus("migration-status", error?.message || "Migration failed.", true);
        });
    });

    document.getElementById("semantic-query")?.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        runSemanticSearch().catch((error) => {
            console.error("Search failed", error);
            setStatus("search-status", error?.message || "Search failed.", true);
        });
    });

    document.getElementById("semantic-query")?.addEventListener("input", (event) => {
        if (event.target.value.trim() !== "") return;
        state.semanticChainsText = "";
        state.highlightFactIds = new Set();
        state.lastSearchResult = null;
        renderSearchResults([]);
        renderQueryPhrases([]);
        renderSeedFacts([]);
        renderDebugTrace(null);
        setStatus("search-status", "");
        updateMatches();
        if (!state.isPhysicsActive) render();
    });

    document.getElementById("copy-search")?.addEventListener("click", () => {
        const textToCopy = state.semanticChainsText || state.lastSearchResult?.text || "";
        if (!textToCopy) return;
        navigator.clipboard.writeText(textToCopy).then(() => {
            const button = document.getElementById("copy-search");
            if (!button) return;
            const originalTitle = button.title;
            button.title = "Copied!";
            setTimeout(() => {
                button.title = originalTitle;
            }, 2000);
        });
    });

    document.getElementById("search-input")?.addEventListener("input", (event) => {
        state.searchQuery = event.target.value.toLowerCase();
        updateMatches();
        if (!state.isPhysicsActive) render();
    });

    document.getElementById("search-agent-name")?.addEventListener("change", () => {
        loadGraph().catch((error) => {
            console.error("Scoped graph refresh failed", error);
            setStatus("search-status", error?.message || "Scoped graph refresh failed.", true);
        });
    });

    // --- Categories event listeners ---

    document.getElementById("search-cat-add")?.addEventListener("click", () => {
        const input = document.getElementById("search-cat-input");
        if (input) {
            addSearchCategory(input.value);
            input.value = "";
            input.focus();
        }
    });

    document.getElementById("search-cat-input")?.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            addSearchCategory(event.target.value);
            event.target.value = "";
        }
    });

    const fadeCoeffInput = document.getElementById("fade-coeff");
    const fadeCoeffVal = document.getElementById("fade-coeff-val");
    if (fadeCoeffInput && fadeCoeffVal) {
        fadeCoeffInput.addEventListener("input", (event) => {
            state.fadeCoeff = parseFloat(event.target.value);
            fadeCoeffVal.textContent = state.fadeCoeff.toFixed(2);
            requestAnimationFrame(render);
        });
    }

    document.getElementById("toggle-sim")?.addEventListener("change", (event) => {
        state.isPhysicsActive = event.target.checked;
        if (state.isPhysicsActive && simulationRef) {
            simulationRef.alpha(0.1).restart();
        } else if (simulationRef) {
            simulationRef.stop();
            render();
        }
    });

    document.getElementById("show-labels")?.addEventListener("change", (event) => {
        state.showLabels = event.target.checked;
        requestAnimationFrame(render);
    });
}

main();
