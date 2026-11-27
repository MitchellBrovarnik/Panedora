const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Diagnostics } = require('../diagnostics');

function directoryFor(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'panedora-diagnostics-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('on reopening after a force-kill, the prior session remains available for export', t => {
    const directory = directoryFor(t);
    const result = spawnSync(process.execPath, ['-e', `
        const { Diagnostics } = require(process.argv[1]);
        const diagnostics = new Diagnostics(process.argv[2], { version: 'fixture' });
        diagnostics.record('Appearance restored', { theme: 'saved', effect: 'saved' });
        diagnostics.record('Window became unresponsive');
        process.kill(process.pid, 'SIGKILL');
    `, require.resolve('../diagnostics'), directory], { timeout: 10000 });
    assert.ifError(result.error);
    assert.notEqual(result.status, 0);

    const current = new Diagnostics(directory, { version: 'fixture' });
    current.record('Appearance restored', { theme: 'missing', effect: 'missing' });
    const report = current.report();
    assert.equal(report.previousInterrupted, true);
    const { sessions } = JSON.parse(report.text);
    const previous = sessions.find(session => session.events.some(event => event.event === 'Window became unresponsive'));
    assert.equal(previous.closedAt, null);
    assert.equal(previous.events[0].theme, 'saved');
    assert.ok(sessions.some(session => session.events[0]?.theme === 'missing'));
    assert.ok(sessions.every(session => !('pid' in session)));
    current.close();
    assert.equal(new Diagnostics(directory, { version: 'fixture' }).report().previousInterrupted, false);
});

test('the log retains recent sessions and events and reports clean exits', t => {
    const directory = directoryFor(t);
    for (let i = 0; i < 7; i++) {
        const diagnostics = new Diagnostics(directory, { version: 'fixture' });
        diagnostics.close();
    }
    const diagnostics = new Diagnostics(directory, { version: 'fixture' });
    for (let i = 0; i < 75; i++) diagnostics.record('Window started loading');
    diagnostics.record('Window recovered');

    const report = diagnostics.report();
    assert.equal(report.previousInterrupted, false);
    const { sessions } = JSON.parse(report.text);
    assert.ok(sessions.length <= 4);
    assert.equal(fs.readdirSync(directory).length, sessions.length);
    const current = sessions.find(session => session.closedAt === null);
    assert.equal(current.events.length, 60);
    assert.equal(current.events.at(-1).event, 'Window recovered');
    assert.ok(sessions.every(session => session.startedAt));
});
