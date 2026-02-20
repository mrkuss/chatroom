const { db } = require('../lib/db');

function initPollJobs(io) {
  setInterval(async () => {
    try {
      const due = await db.query(`SELECT * FROM polls WHERE concluded = false AND ends_at <= NOW()`);
      for (const poll of due.rows) {
        const tally = {};
        poll.options.forEach(o => tally[o] = 0);
        Object.values(poll.votes || {}).forEach(v => { if (tally[v] !== undefined) tally[v]++; });
        const total = Object.values(tally).reduce((a, b) => a + b, 0);

        let msg;
        if (total === 0) {
          msg = `Poll "${poll.question}" ended with no votes.`;
        } else {
          const sorted = Object.entries(tally).sort((a, b) => b[1] - a[1]);
          const topCount = sorted[0][1];
          const tied = sorted.filter(([, v]) => v === topCount);
          msg = tied.length > 1
            ? `Poll "${poll.question}" ended in a tie between: ${tied.map(([k]) => `"${k}"`).join(', ')} (${topCount} vote${topCount !== 1 ? 's' : ''} each)`
            : `Poll "${poll.question}" — winner: "${sorted[0][0]}" with ${topCount} vote${topCount !== 1 ? 's' : ''} out of ${total}`;
        }

        await db.query(`UPDATE polls SET concluded = true WHERE id = $1`, [poll.id]);
        io.to(poll.room).emit('poll concluded', { pollId: poll.id, message: msg });
        io.to(poll.room).emit('system message', `🏆 ${msg}`);
      }
    } catch (err) {
      console.error('Poll conclusion error:', err);
    }
  }, 15000);
}

module.exports = { initPollJobs };