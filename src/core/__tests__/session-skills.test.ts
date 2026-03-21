import test from 'node:test';
import assert from 'node:assert/strict';
import { Session, formatLocalDeviceTime } from '../Session.js';
import { SkillsService } from '../../skills_system/SkillsService.js';

function createSession(tools: any[] = []): Session {
  return new Session({
    agent: {
      config: {
        name: 'test-agent',
        model: 'test-model',
        systemPrompt: 'system.md',
        tools: [],
        loop: 'default',
        syntax: 'xml-tags',
      },
      systemPromptContent: 'Base instructions.',
      directory: process.cwd(),
    } as any,
    provider: {
      name: 'test-provider',
      complete: async () => ({ content: '', finishReason: 'stop' as const }),
    } as any,
    syntax: {
      name: 'xml-tags',
      getThinking: () => null,
      getAction: () => null,
      getObservation: () => null,
      getCli: () => null,
      getSkills: () => null,
      getFiles: () => [],
      getDiffs: () => [],
      getEdits: () => [],
      hasAction: () => false,
      hasCli: () => false,
      isActionClosed: () => false,
      isCliClosed: () => false,
      hasAnyClosedBlock: () => false,
      wrapThinking: (content: string) => content,
      wrapAction: (content: string) => content,
      wrapObservation: (content: string) => content,
      wrapCli: (content: string) => content,
      wrapSkills: (content: string) => content,
      getDescription: () => '',
    } as any,
    loop: {
      name: 'default',
      processResponse: () => ({
        hasAction: false,
        actionCode: null,
        hasCli: false,
        cliCommand: null,
        filesToWrite: [],
        diffs: [],
        edits: [],
        fullResponse: '',
      }),
      buildContinuationMessages: () => ({
        updatedAssistantContent: '',
        continuationUserMessage: '',
      }),
      getDescription: () => '',
    } as any,
    tools,
    sandbox: {
      id: 'sandbox',
      directory: process.cwd(),
      initialize: async () => {},
      execute: async () => ({ success: true, output: '' }),
      executeCli: async () => ({ success: true, output: '' }),
      parseSearchReplace: () => [],
      applySearchReplace: async () => ({ success: true, output: '' }),
      cleanup: async () => {},
      getDescription: () => '',
    } as any,
  });
}

test('refreshSkillsContext appends retrieved skills to the system prompt and avoids duplicates', async () => {
  const session = createSession();
  session.addUserMessage('Help me fix the build');

  const seenMessages: any[] = [];
  let retrievedCalls = 0;

  Object.defineProperty(session, 'skillsService', {
    value: {
      searchHistory: async (messages: any[]) => {
        seenMessages.push(messages);
        return {
          query: 'mock-history-query',
          topScore: 0.93,
          entries: [
            {
              content: 'When a build fails after a CLI tool result, inspect the failing command output first.',
              score: 0.93,
              entry: { id: 'skill-build-debug' },
            },
          ],
        };
      },
      clearPreEmbeddedWords: () => {},
    } as any,
    configurable: true,
  });

  await session.refreshSkillsContext(
    [{ role: 'tool', content: 'npm ERR! missing dependency', toolName: 'cli' } as any],
    {
      onSkillsRetrieved: () => {
        retrievedCalls += 1;
      },
    }
  );

  assert.match(session.getSystemPrompt(), /SKILLS:\n\nWhen a build fails after a CLI tool result/);
  assert.match(session.getSystemPrompt(), /SKILLS:[\s\S]*Local device time: [A-Za-z]+, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(retrievedCalls, 1);
  assert.equal(seenMessages[0]?.[0]?.role, 'user');
  assert.equal(seenMessages[0]?.[1]?.role, 'tool');
  assert.equal(seenMessages[0]?.[1]?.toolName, 'cli');

  await session.refreshSkillsContext(
    [{ role: 'tool', content: 'npm ERR! missing dependency', toolName: 'cli' } as any],
    {
      onSkillsRetrieved: () => {
        retrievedCalls += 1;
      },
    }
  );

  assert.equal(retrievedCalls, 1);
  assert.equal(session.getSystemPrompt().split('skill-build-debug').length - 1, 0);
  assert.equal(session.getSystemPrompt().split('When a build fails after a CLI tool result').length - 1, 1);
});

test('Session creates a skills service when a loaded tool contributes embedded skills', () => {
  const session = createSession([
    {
      config: {
        name: 'demo',
        description: 'Demo tool',
        module: 'index.ts',
        skills: { enabled: true, directory: 'skills' },
      },
      directory: process.cwd(),
      absolutePath: process.cwd(),
      skillEntries: [
        {
          id: 'demo:skills:0',
          toolName: 'demo',
          content: 'Use demo.lookup when a user needs demo data.',
          examples: ['Need demo data'],
          updatedAt: Date.now(),
          filePath: 'tools/demo/skills/entry.json',
        },
      ],
    },
  ]);

  assert.ok(session.skillsService);
});

test('Session appends the local device time context to the system prompt', () => {
  const session = createSession();
  const fixedNow = new Date('2026-03-18T15:04:05');

  assert.equal(formatLocalDeviceTime(fixedNow), 'Local device time: Wednesday, 2026-03-18 15:04:05');

  const prompt = session.getSystemPrompt();
  assert.match(prompt, /Local device time: [A-Za-z]+, \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
});
