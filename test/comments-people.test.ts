import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../src/page/comments.js', import.meta.url), 'utf8');
const peopleCode = source.slice(source.indexOf('  let peopleSig = null;'), source.indexOf('  async function focusPerson('));
const eventsCode = source.split('\n').filter(line =>
  line.startsWith('  host.on("resync",') || line.startsWith('  host.on("visible",') ||
  line.startsWith('  document.addEventListener("visibilitychange",')
).join('\n');

for (const event of ['resync', 'visibilitychange']) {
  for (const cloud of [true, false]) {
    test(`cached ${cloud ? 'Cloud' : 'local'} tab resends native people on ${event}`, () => {
      const handlers = new Map<string, (() => void)[]>();
      const listen = (name: string, fn: () => void) => handlers.set(name, [...(handlers.get(name) || []), fn]);
      const messages: any[] = [];
      const sidebarMessages: boolean[] = [];
      const element = () => ({ classList: { toggle() {} }, style: {}, dataset: {}, append() {}, replaceChildren() {}, setAttribute() {} });
      const context = vm.createContext({
        window: { canvasCloudFile: cloud ? { status: 'connected', role: 'editor', author: { name: 'First tab' } } : null },
        sidebar: { hidden: !cloud }, st: { sync: null }, shared: element(), h: element, lbl: (text: string) => text,
        L: { colorOf: () => '#123456', initialOf: () => 'F' },
        host: { native: true, presence: { people: [] }, on: listen, post: (message: any) => { if (message.peopleStrip) messages.push(message); if (typeof message.commentsSidebar === 'boolean') sidebarMessages.push(message.commentsSidebar); } },
        document: { hidden: false, addEventListener: listen }, schedule() {},
      });
      vm.runInContext(`${peopleCode}\nfunction load() { drawShared(); }\n${eventsCode}\ndrawShared(); drawShared();`, context);
      assert.equal(messages.length, 1, 'unchanged roster normally sends once');
      const expected = JSON.stringify(messages[0]);
      messages.push({ peopleStrip: { people: [{ name: 'Other tab' }] } });
      for (const handler of handlers.get(event) || []) handler();
      assert.equal(JSON.stringify(messages.at(-1)), expected, 'shown tab restores its own people even with an unchanged roster');
      assert.equal(messages.length, 3, 'one forced resend');
      if (event === 'resync') assert.deepEqual(sidebarMessages, [cloud], 'shown tab restores its own sidebar state');
    });
  }
}
