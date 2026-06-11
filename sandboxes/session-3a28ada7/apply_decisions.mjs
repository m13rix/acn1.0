const s = globalThis.strategy;

async function main() {
  const k1 = await s.routes.keep("route_75dfae40b197", {
    rank: 1,
    confidence: 0.85,
    evidence: "Memory: sensual overexcitability, intellectualization coping style. Web: ISO Principle gold standard, Tuned In program 98% attendance + p<0.01 improvements.",
    decisionReason: "Strongest evidence base. Best psychological fit. Lowest friction. Clearest obsolescence path. Fastest feedback loop."
  });
  console.log("Music Ladder KEPT:", JSON.stringify(k1).substring(0, 200));

  const k2 = await s.routes.kill("route_50809ed45dcd", {
    rank: 2,
    confidence: 0.65,
    evidence: "Memory: self-criticism, observer protocol. Web: self-talk interventions evidence-based but format has less support.",
    decisionReason: "Lower evidence base for audio format. Cringe barrier risk. Crisis accessibility risk."
  });
  console.log("Speech Protocol KILLED:", JSON.stringify(k2).substring(0, 200));

  const k3 = await s.routes.kill("route_ee59540143ba", {
    rank: 3,
    confidence: 0.80,
    evidence: "Web: A52 Breath Method (Little 2025), diaphragmatic breathing systematic review (Tsakona 2025).",
    decisionReason: "Lower psychological fit. Boredom risk. Paced breathing embeddable within Music Ladder."
  });
  console.log("Breathing App KILLED:", JSON.stringify(k3).substring(0, 200));

  const k4 = await s.routes.kill("route_54e38dec4abc", {
    rank: 4,
    confidence: 0.70,
    evidence: "Memory: lonely, no therapist. Web: DBT-A evidence-based, mentoring positive impacts.",
    decisionReason: "Not a scaffolding tool. Depends on external factors. Cross-cutting metric."
  });
  console.log("Human Bridge KILLED:", JSON.stringify(k4).substring(0, 200));
  
  console.log("DONE");
}

main().catch(e => console.error(e));
