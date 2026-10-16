import test from 'node:test';
import assert from 'node:assert/strict';
import { CommandProcessor } from '../src/commands.mjs';
import { temporaryDatabase } from './helpers.mjs';

test('app commands stay out of fiction and update only the selected branch', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const { project, branch, thread } = db.createProject({ name: 'Command Test' });
  const alternate = db.createBranch(thread.id, 'Ashes');
  const commands = new CommandProcessor(db);

  const meta = commands.process(thread.id, '/meta Keep the ending unresolved for now.');
  assert.match(meta.output, /saved for this project branch/i);
  assert.equal(db.listMetaNotes(project.id, branch.id)[0].content, 'Keep the ending unresolved for now.');
  assert.match(commands.process(thread.id, '/scene set location="Golden Hall" time="Dawn of Winter" participants="Mara, Iven" conditions="the bells are silent"').output, /Current scene updated/);
  const scene = db.getEffectiveLedger(project.id, branch.id).find((item) => item.type === 'scene');
  assert.equal(scene.details.location, 'Golden Hall');
  assert.equal(scene.details.time, 'Dawn of Winter');
  assert.equal(scene.details.conditions, 'the bells are silent');
  assert.deepEqual(scene.sourceMessageIds.length, 1);

  const character = commands.process(thread.id, '/character add "Mara Vale" role="court astronomer" aliases="Mara, Star Reader" goals="find the lost map" knowledge="she witnessed the eclipse"');
  assert.match(character.output, /Added character profile/);
  assert.equal(commands.process(thread.id, '/character show "Star Reader"').output.includes('court astronomer'), true);
  assert.match(commands.process(thread.id, '/character set "Mara Vale" condition="exhausted but alive"').output, /Updated character profile/);
  assert.equal(db.getEffectiveLedger(project.id, branch.id).find((item) => item.type === 'character' && item.subject === 'Mara Vale').details.condition, 'exhausted but alive');

  commands.process(thread.id, '/style Write with restrained, lyrical prose and no omniscient spoilers.');
  assert.match(db.getProject(project.id).style, /restrained, lyrical prose/);
  const status = commands.process(thread.id, '/status');
  assert.match(status.output, /Scene: location: Golden Hall/);
  assert.match(commands.process(thread.id, '/recap').output, /Source-backed recap/);
  const checkpoint = commands.process(thread.id, '/checkpoint');
  assert.match(checkpoint.output, /"format": "timeless-sovereign-checkpoint"/);
  assert.equal(db.listCheckpoints(project.id, branch.id).length, 1);

  const recordId = scene.id;
  const retcon = commands.process(thread.id, `/retcon ${recordId} -- The scene is the western gallery, not the Golden Hall.`);
  assert.match(retcon.output, /Correction recorded/);
  const activeScene = db.getEffectiveLedger(project.id, branch.id).find((item) => item.type === 'scene');
  assert.match(activeScene.content, /western gallery/);
  assert.equal(db.getLedgerItem(project.id, branch.id, recordId).status, 'superseded');
  assert.ok(db.listLedgerHistory(project.id, branch.id).some((entry) => entry.action === 'retcon'));

  const beforeBranch = db.getEffectiveLedger(project.id, alternate.branch.id);
  assert.equal(beforeBranch.some((item) => item.type === 'scene'), false);
  commands.process(alternate.thread.id, '/scene set location="Ashen Shore"');
  assert.equal(db.getEffectiveLedger(project.id, alternate.branch.id).find((item) => item.type === 'scene').details.location, 'Ashen Shore');
  assert.equal(db.getEffectiveLedger(project.id, branch.id).find((item) => item.type === 'scene').details.location, 'Golden Hall');

  commands.process(thread.id, '/pause');
  assert.equal(db.getThread(thread.id).paused, true);
  commands.process(thread.id, '/resume');
  assert.equal(db.getThread(thread.id).paused, false);
  const invalid = commands.process(thread.id, '/scene set location=');
  assert.match(invalid.output, /value for "location" cannot be empty/i);
  const incomplete = commands.process(thread.id, '/retcon');
  assert.match(incomplete.output, /ledger record ID and correction are required/i);
  const unknown = commands.process(thread.id, '/pretend');
  assert.match(unknown.output, /Unknown command/);

  const transcript = db.getTranscript(thread.id);
  assert.equal(transcript.filter((message) => message.role === 'assistant').length, 0);
  assert.ok(transcript.filter((message) => message.role === 'user').every((message) => message.kind === 'command'));
  assert.ok(transcript.filter((message) => message.role === 'system').every((message) => message.kind === 'command'));
});

test('commands on a paused thread remain usable and inspection commands do not create memory jobs', async (t) => {
  const { database: db } = await temporaryDatabase(t);
  const created = db.createProject({ name: 'Paused commands' });
  const processor = new CommandProcessor(db);
  processor.process(created.thread.id, '/pause');
  assert.equal(processor.process(created.thread.id, '/status').handled, true);
  assert.equal(processor.process(created.thread.id, '/resume').handled, true);
  assert.equal(db.listMemoryJobs(created.project.id, created.branch.id, true).length, 0);
});
