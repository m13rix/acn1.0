const { GoogleGenAI } = require('@google/genai');
const ai = new GoogleGenAI({ /* ваши опции */ });

async function clearAllStores() {
    // сначала получаем список всех хранилищ
    const stores = await ai.fileSearchStores.list();
    for await (const store of stores) {
        console.log('Deleting store:', store.name);
        await ai.fileSearchStores.delete({
            name: store.name,
            config: { force: true }
        });
    }
}

clearAllStores().catch(console.error);
