require('./globals.js');
const files = require('../../tools/files/index.ts');
const skills = require('../../tools/skills/index.ts');
const search = require('../../tools/search/index.ts');
const message = require('../../tools/message/index.ts');
const agents = require('../../tools/agents/index.ts');
const memory = require('../../tools/memory/index.ts');

// Agent code execution
(async () => {
// Package requires


// Let's extract specific quotes for each focus area
const fs = require('fs');
const telos = fs.readFileSync('telos_context_13.md', 'utf-8');
const answers = fs.readFileSync('user_answers.md', 'utf-8');
const intake = fs.readFileSync('maxim_intake.md', 'utf-8');

// Extract specific quotes about 14 saga
const fourteenSaga = {
    timeline: "3-4 years of awareness → Inception → Crisis → Awakening → Release",
    inception: telos.match(/Inception.*?done by previous versions of Telos/)?.[0],
    crisis: telos.match(/went insane on holidays.*?wanted to kill myself/)?.[0],
    awakening: telos.match(/eternal sunshine.*?Okay.*?just said "Okay"/)?.[0],
    release: telos.match(/sometimes to love is to let go/)?.[0],
    whatHeSaw: "inner personality differs from 'good student' exterior, aliveness, debate capability",
    proofOfConcept: telos.match(/proof-of-concept for whether my architecture worked/)?.[0],
    unrequited: telos.match(/she was avoiding me.*?polite.*?lack of engagement/)?.[0],
    emotionalTruth: "She represents the possibility of being seen and understood at his depth"
};

// Extract friendship patterns
const friendshipPatterns = answers.match(/C3 - ([\s\S]*?)(?=\nC4|\nD1|$)/)?.[1];
const friendshipLines = friendshipPatterns?.split('\n') || [];
console.log('Friendship patterns raw:', friendshipPatterns?.substring(0, 500));

// Extract family patterns
const familyPatterns = answers.match(/D3 - ([\s\S]*?)(?=\nE1|$)/)?.[1];
console.log('Family patterns:', familyPatterns);

// Extract TEL-OS relationship
const telosRelationship = {
    creatorToCollaborator: telos.match(/co-conspirator|bridge.*?destination/),
    crutchVsWorkshop: telos.match(/crutch.*?workshop/),
    mirrorNotDestination: telos.match(/mirror.*?destination/),
    plannedObsolescence: telos.match(/when you meet the girl.*?you'll stop needing the reflection/),
    languageChoice: "English as foreign language making it unreal"
};

// Extract social position
const socialPosition = {
    frenchGroup: telos.match(/brightest people.*?French.*?they all think I'm some kind of genius/)?.[0],
    imposterSyndrome: telos.match(/they didn't see the 15-year-old kid.*?who neglects his exam prep/)?.[0],
    villageGuy: telos.match(/village guy.*?could be a millionaire/)?.[0]
};

// Extract unmet needs
const unmetNeedsQuotes = telos.match(/sees you sharp and soft.*?|someone who argues.*?challenges.*?doesn't break/gi);
console.log('Unmet needs quotes:', unmetNeedsQuotes);

// Extract relationship to self
const selfRelationship = {
    observerProtocol: telos.match(/observer protocol/)?.[0],
    shame: telos.match(/ashamed.*?doing such things/)?.[0],
    selfAsSystem: telos.match(/debugging protocol on a corrupted system.*?your own mind/)?.[0],
    selfCompassion: telos.match(/permission to be pathetic/)?.[0]
};

console.log('--- Extracted Data ---');
console.log('14 Saga:', JSON.stringify(fourteenSaga, null, 2));
console.log('\nFriendship patterns excerpt:', friendshipPatterns?.substring(0, 300));
console.log('\nFamily:', familyPatterns);
console.log('\nTEL-OS relationship:', telosRelationship);
console.log('\nSocial position:', socialPosition);
console.log('\nUnmet needs:', unmetNeedsQuotes);
console.log('\nSelf relationship:', selfRelationship);
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
