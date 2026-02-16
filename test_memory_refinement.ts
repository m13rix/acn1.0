import { setGlobalDisplay, getGlobalDisplay } from './src/core/GlobalDisplay.js';
import { MemoryService } from './src/memory_system/MemoryService.js';
import { COLORS, SYMBOLS, StreamDisplay } from './src/cli/display.js';

// Setup display
if (!getGlobalDisplay()) {
    setGlobalDisplay(new StreamDisplay());
}

async function testRefinement() {
    const service = new MemoryService({
        table: 'test_memory_refinement',
        linkerProvider: 'google', // Explicitly google
        linkerModel: 'gemini-1.5-flash', // Fast model for testing
        embeddingModel: 'text-embedding-004',
        dedupeThreshold: 0.98, // Explicitly testing the new threshold
    });

    try {
        await service.initialize();
        console.log("\n=== TEST PART 1: Deduplication Logic ===");

        const fact1 = `(Гипотеза 1) Мир как источник стимуляции: Основной, почти висцеральный драйвер — избегание состояния внутренней пустоты/скуки. Социальные взаимодействия, правила и другие люди воспринимаются не как объекты для эмпатии, а как инструменты для генерации эмоциональных "всплесков". (Уверенность: 90%)`;

        const fact2 = `(Гипотеза 2) Отсутствие целостного "Я": Субъект не обладает стабильной, интегрированной личностью. Существует как минимум два конфликтующих под-агента: "Игнат-провокатор" (действующий в "горячем" состоянии) и "Игнат-жертва" (активирующийся в "холодном" состоянии под давлением). Они не имеют прямого доступа к мотивации друг друга. (Уверенность: 85%)`;

        console.log("Adding Fact 1...");
        const res1 = await service.addFact({
            fact: fact1,
            confidence: 0.9,
            topics: ["Психология", "Гипотеза", "Игнат"],
            ref: "hypothesis_1"
        });
        console.log(`Result 1: ${JSON.stringify(res1)}`);

        console.log("\nAdding Fact 2 (Should NOT be a duplicate)...");
        const res2 = await service.addFact({
            fact: fact2,
            confidence: 0.85,
            topics: ["Психология", "Гипотеза", "Игнат"],
            ref: "hypothesis_2"
        });
        console.log(`Result 2: ${JSON.stringify(res2)}`);

        console.log("\n=== TEST PART 2: Linker Logic ===");
        // Fact 2 should ideally link to Fact 1 with CONTINUES, ELABORATES, or similar, NOT "CONTRASTS" or "RELATED_TO" if possible.
        // We can't easily check the *content* of the auto-links programmatically here without querying the DB or looking at logs,
        // but the console output from MemoryService debug instructions will show us the link types.

    } catch (e) {
        console.error("Test failed:", e);
    }
}

testRefinement();
