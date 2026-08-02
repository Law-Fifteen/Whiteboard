const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS });
    }

    try {
      const url = new URL(request.url);

      if (request.method === 'GET') {
        const tasks = await ghGet(env);
        return json(tasks);
      }

      if (request.method === 'POST') {
        const body = await request.json();

        if (body.action === 'notify') {
          await sendEmail(env, body.task, body.emails);
          return json({ ok: true });
        }

        if (body.action === 'cron-check') {
          const result = await checkDeadlines(env);
          return json(result);
        }

        if (body.action === 'save' && body.tasks) {
          await ghPut(env, body.tasks);
          return json({ ok: true });
        }

        return json({ error: 'Unknown action' }, 400);
      }

      return json({ error: 'Method not allowed' }, 405);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  },

  async scheduled(event, env) {
    await checkDeadlines(env);
  }
};

async function ghGet(env) {
  const r = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/data/tasks.json`,
    {
      headers: {
        'Authorization': `token ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );

  if (r.status === 404) return [];
  if (!r.ok) throw new Error(`GitHub GET failed: ${r.status}`);

  const data = await r.json();
  return JSON.parse(atob(data.content));
}

async function ghPut(env, tasks) {
  const content = btoa(JSON.stringify(tasks, null, 2));

  let sha = null;
  const getR = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/data/tasks.json`,
    {
      headers: {
        'Authorization': `token ${env.GITHUB_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
      },
    }
  );
  if (getR.ok) {
    const d = await getR.json();
    sha = d.sha;
  }

  const body = {
    message: `Update tasks ${new Date().toISOString()}`,
    content,
  };
  if (sha) body.sha = sha;

  const putR = await fetch(
    `https://api.github.com/repos/${env.GITHUB_REPO}/contents/data/tasks.json`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `token ${env.GITHUB_TOKEN}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json',
      },
      body: JSON.stringify(body),
    }
  );

  if (!putR.ok) {
    const err = await putR.text();
    throw new Error(`GitHub PUT failed: ${putR.status} ${err}`);
  }
}

async function checkDeadlines(env) {
  const tasks = await ghGet(env);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let notified = false;

  for (const task of tasks) {
    if (task.completed || !task.deadline) continue;

    const dl = new Date(task.deadline + 'T12:00:00');
    const dlDay = new Date(dl.getFullYear(), dl.getMonth(), dl.getDate());
    const diff = Math.round((dlDay - today) / (1000 * 60 * 60 * 24));

    if (diff === 1 || diff === 0) {
      const notifiedKey = `${task.id}_${diff}`;
      if (!task._notified) task._notified = [];
      if (!task._notified.includes(notifiedKey)) {
        task._notified.push(notifiedKey);
        await sendEmail(env, task, env.NOTIFY_EMAILS.split(','));
        notified = true;
      }
    }
  }

  if (notified) {
    await ghPut(env, tasks);
  }

  return { checked: tasks.length, notified };
}

async function sendEmail(env, task, emails) {
  const subject = `${task.header} - Approaching Deadline`;
  const deadlineDate = task.deadline;
  const daysLeft = getDaysLeft(deadlineDate);

  const htmlBody = `
    <div style="font-family:Inter,Segoe UI,system-ui,sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0D0F13;color:#F5F5F5;border-radius:16px">
      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:48px;margin-bottom:8px">&#9200;</div>
        <h1 style="font-size:24px;font-weight:700;margin:0;color:#F5F5F5">Deadline ${daysLeft}</h1>
      </div>
      <div style="background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:20px;margin-bottom:24px">
        <div style="font-size:13px;color:#808891;margin-bottom:6px">TASK</div>
        <div style="font-size:18px;font-weight:600;margin-bottom:12px">${escapeHtml(task.header)}</div>
        <div style="font-size:13px;color:#808891;margin-bottom:6px">DEADLINE</div>
        <div style="font-size:15px;color:#6AA9FF;font-weight:500">${deadlineDate}</div>
      </div>
      <div style="text-align:center;color:#808891;font-size:12px">
        <p style="margin:0">Whiteboard Task Manager</p>
        <p style="margin:4px 0 0">Don't forget to complete this task!</p>
      </div>
    </div>`;

  const textBody = `Deadline ${daysLeft}\n\nTask: ${task.header}\nDeadline: ${deadlineDate}\n\nDon't forget to complete this task!\n\n- Whiteboard Task Manager`;

  for (const email of emails) {
    const trimmed = email.trim();
    if (!trimmed) continue;

    try {
      await fetch('https://api.mailchannels.net/tx/v1/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          personalizations: [{ to: [{ email: trimmed }] }],
          from: { email: 'whiteboard@morganambrose.work', name: 'Whiteboard' },
          subject,
          content: [
            { type: 'text/plain', value: textBody },
            { type: 'text/html', value: htmlBody },
          ],
        }),
      });
    } catch (e) {
      console.error(`Email to ${trimmed} failed:`, e);
    }
  }
}

function getDaysLeft(deadline) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dl = new Date(deadline + 'T12:00:00');
  const dlDay = new Date(dl.getFullYear(), dl.getMonth(), dl.getDate());
  const diff = Math.round((dlDay - today) / (1000 * 60 * 60 * 24));
  if (diff < 0) return `${Math.abs(diff)} days overdue`;
  if (diff === 0) return 'is TODAY';
  if (diff === 1) return 'is TOMORROW';
  return `is in ${diff} days`;
}

function escapeHtml(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}
