// Notes kept in the window's own store; JARVIS can read them aloud or be asked about one.
const list = document.getElementById('list');
const text = document.getElementById('text');
let notes = [];

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function render() {
  document.getElementById('count').textContent = notes.length ? `${notes.length} шт.` : '';
  list.innerHTML = notes.length
    ? notes.map((n, i) => `<li class="note">
        <p>${esc(n.text)}</p>
        <footer>
          <time>${new Date(n.at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</time>
          <button class="btn" data-act="say" data-i="${i}">Озвучить</button>
          <button class="btn" data-act="ask" data-i="${i}">Джарвису</button>
          <button class="btn danger" data-act="del" data-i="${i}">×</button>
        </footer>
      </li>`).join('')
    : '<li class="empty">Заметок пока нет.</li>';
}

async function save() {
  await jarvis.store.set('notes', notes);
  render();
}

document.getElementById('add').addEventListener('submit', async (e) => {
  e.preventDefault();
  const value = text.value.trim();
  if (!value) return;
  notes.unshift({ text: value, at: Date.now() });
  text.value = '';
  await save();
});

text.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) document.getElementById('add').requestSubmit();
});

list.addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const note = notes[Number(b.dataset.i)];
  if (b.dataset.act === 'say') jarvis.say(note.text);
  if (b.dataset.act === 'ask') jarvis.ask(`Вот моя заметка: «${note.text}». Помоги с ней.`);
  if (b.dataset.act === 'del') { notes.splice(Number(b.dataset.i), 1); await save(); }
});

(async () => {
  notes = (await jarvis.store.get('notes')) || [];
  render();
  text.focus();
})();
