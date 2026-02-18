require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const srcAgent = require('../../tools/srcAgent/index.ts');
const heartbeat = require('../../tools/heartbeat/index.ts');
const memory = require('../../tools/memory/index.ts');

// Agent code execution
(async () => {
// Package requires


// Исправляю ошибку: перепутал `file` (название инструмента CLI) с модулем.
    // Для записи файлов внутри `action` используем `fs.writeFileSync`.
    const fs = require('fs');

    // 1. Создаем заголовок
    fs.writeFileSync('research_domain_13.md', '# Domain Research: Psychological & Philosophical Frameworks (Raw Data)\n\nstatus: In Progress\n\n');

    try {
        // PART 1
        console.log("Starting Part 1: Giftedness...");
        const res1 = await search.research("Psychological profiles of gifted adolescents (high IQ, asynchronous development) in computer science. Relationship between intellectual gifts and social isolation. The 'burden of potential'.");
        fs.appendFileSync('research_domain_13.md', `## 1. GIFTED ADOLESCENTS + TECHNOLOGY CREATORS\n\n${res1.output}\n\n---\n\n`);

        // PART 2
        console.log("Starting Part 2: Systemizing...");
        const res2 = await search.research("Simon Baron-Cohen Systemizing mechanism and romantic obsession (limerence). Cognitive hyper-systemization in relationships. Treating attraction as an optimization problem or solvable theorem.");
        fs.appendFileSync('research_domain_13.md', `## 2. SYSTEMATIZING BRAINS + ROMANTIC OBSESSION\n\n${res2.output}\n\n---\n\n`);

        // PART 3
        console.log("Starting Part 3: Existentialism...");
        const res3 = await search.research("Existential depression in gifted adolescents (Webb). Camus 'Myth of Sisyphus' psychology for teenagers. Positive Disintegration (Dabrowski) and existential crisis. Distinguishing healthy philosophical exploration from depressive pathology.");
        fs.appendFileSync('research_domain_13.md', `## 3. ABSURDIST PHILOSOPHY IN CRISIS\n\n${res3.output}\n\n---\n\n`);

        // PART 4
        console.log("Starting Part 4: Algorithmic Self...");
        const res4 = await search.research("Psychology of 'The Algorithmic Self'. Quantified Self and self-worth optimization. Dangers of viewing the self as a system to be optimized. Impact of AI development on creator's identity formation.");
        fs.appendFileSync('research_domain_13.md', `## 4. THE ALGORITHMIC SELF\n\n${res4.output}\n\n---\n\n`);

        // PART 5
        console.log("Starting Part 5: Attachment...");
        const res5 = await search.research("Dismissive-avoidant attachment in gifted youth without trauma. Intellectualization of emotions as defense mechanism. 'Too intense' personality feedback and social withdrawal. Connection via intellect vs emotion.");
        fs.appendFileSync('research_domain_13.md', `## 5. ATTACHMENT PATTERNS (NON-TRAUMATIC)\n\n${res5.output}\n\n---\n\n`);

        console.log("Research complete. File saved.");
        FINISH("Research complete. Data saved to research_domain_13.md");

    } catch (e) {
        console.error("Error during research:", e);
        // Если произошла ошибка - сохраним то, что успели.
        FINISH("Research partially complete (error occurred). Check logs.");
    }
})().catch(err => {
  console.error(err);
  process.exit(1);
}).then(() => {
  // Keep the event loop alive to allow promise chains (like .then() calls) to complete
  return new Promise(resolve => setTimeout(resolve, 500));
}).catch(err => {
  console.error('Error in promise chain:', err);
  process.exit(1);
});
