// Broadcast graphics. Reads live match state; never touches the simulation.
import { MAP_H, MAP_W } from '../sim/arena.js';
import { FRAG_LIMIT, MAG_SIZE, MAX_HEALTH, ROSTER, TEAMS, TIME_LIMIT } from '../sim/constants.js';
import { RIG_LABELS } from '../director/director.js';

const $ = (id) => document.getElementById(id);
const MAP_SCALE = 4;
const FEED_LIFE = 7;
const MIND_ROWS = 8;

function clock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function drawBaseMap(arena) {
  const c = document.createElement('canvas');
  c.width = MAP_W * MAP_SCALE;
  c.height = MAP_H * MAP_SCALE;
  const g = c.getContext('2d');
  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const h = arena.heights[y * MAP_W + x];
      let color = '#2c4f97';
      if (h >= 8) color = '#0c2150';
      else if (h >= 2.5) color = '#f5f3ec';
      else if (h >= 1.5) color = '#6d8cc9';
      else if (h >= 0.5) color = '#4b6db3';
      else if (h < 0) color = '#1d3a7a';
      g.fillStyle = color;
      g.fillRect(x * MAP_SCALE, y * MAP_SCALE, MAP_SCALE, MAP_SCALE);
    }
  }
  return c;
}

export class Hud {
  constructor(arena, brainInfo) {
    this.arena = arena;
    this.baseMap = drawBaseMap(arena);
    this.mapCtx = $('map').getContext('2d');
    this.feed = [];
    this.calloutT = 0;
    this.visible = true;
    this.lastFirstBlood = false;
    this.mindRows = [];
    this.mindSubject = -1;
    this.tableHeld = false;
    this.series = [0, 0];
    this.brainInfo = brainInfo;

    for (let i = 0; i < MIND_ROWS; i++) {
      const li = document.createElement('li');
      li.innerHTML = '<span></span><div class="bar"><i></i></div>';
      $('mind-bars').append(li);
      this.mindRows.push({ li, label: li.firstChild, bar: li.querySelector('i') });
    }
    $('mind-note').textContent = `${brainInfo.parameters.toLocaleString('en-US')} hand-written weights. ${brainInfo.trainingSteps} training steps.`;
  }

  show() {
    $('hud').hidden = false;
  }

  toggle() {
    this.visible = !this.visible;
    $('hud').hidden = !this.visible;
  }

  callout(text, seconds = 2.2) {
    const el = $('callout');
    el.textContent = text;
    el.classList.add('on');
    this.calloutT = seconds;
  }

  newMatch() {
    this.lastFirstBlood = false;
    this.feed = [];
    $('feed').replaceChildren();
    $('table').hidden = true;
  }

  onEvent(e, world) {
    if (e.type === 'kill') {
      this.addFeed(e);
      const name = ROSTER[e.bot].name;
      if (!this.lastFirstBlood) {
        this.lastFirstBlood = true;
        this.callout(`First blood to ${name}`);
      } else if (e.streak === 3) this.callout(`${name} has three in a row`);
      else if (e.streak === 5) this.callout(`${name} is running riot`);
      else if (e.streak >= 7) this.callout(`${name}: ${e.streak} straight`);
      if (Math.max(...e.score) === FRAG_LIMIT - 1) this.callout('Match point');
    } else if (e.type === 'overchargeUp') {
      this.callout('Overcharge is up', 1.8);
    } else if (e.type === 'overchargeTaken') {
      this.callout(`${ROSTER[e.bot].name} takes the overcharge`);
    } else if (e.type === 'overtime') {
      this.callout('Sudden death', 3);
    } else if (e.type === 'matchStart') {
      this.callout('Live', 1.2);
    } else if (e.type === 'matchEnd') {
      this.series[e.team]++;
      this.callout(`${TEAMS[e.team].name} wins ${world.score[e.team]} to ${world.score[1 - e.team]}`, 4);
    }
  }

  addFeed(e) {
    const li = document.createElement('li');
    const killer = document.createElement('span');
    killer.className = `t${TEAMS[e.bot < 4 ? 0 : 1].id}`;
    killer.textContent = ROSTER[e.bot].name;
    const how = document.createElement('span');
    how.className = 'how';
    how.textContent = e.head ? 'headshot' : 'scrapped';
    const victim = document.createElement('span');
    victim.className = `t${TEAMS[e.victim < 4 ? 0 : 1].id}`;
    victim.textContent = ROSTER[e.victim].name;
    li.append(killer, how, victim);
    $('feed').prepend(li);
    this.feed.push({ li, t: FEED_LIFE });
    while ($('feed').children.length > 5) $('feed').lastChild.remove();
  }

  setTable(held) {
    this.tableHeld = held;
  }

  renderTable(world) {
    const rows = [0, 1].map((team) => {
      const players = world.bots
        .filter((b) => b.team === team)
        .sort((p, q) => q.kills - p.kills || p.deaths - q.deaths)
        .map(
          (b) => `<tr><td class="t${team}">${b.name}</td><td>${b.kills}</td><td>${b.deaths}</td><td>${b.assists}</td>` +
            `<td>${Math.round(b.damage)}</td><td>${Math.round((100 * b.hits) / Math.max(1, b.shots))}%</td><td>${b.bestStreak}</td></tr>`,
        )
        .join('');
      return `<tr class="team"><td class="t${team}" colspan="7">${TEAMS[team].name} ${world.score[team]}</td></tr>${players}`;
    });
    $('table-body').innerHTML =
      '<table><thead><tr><th scope="col">Player</th><th scope="col">Kills</th><th scope="col">Deaths</th><th scope="col">Assists</th>' +
      `<th scope="col">Damage</th><th scope="col">Accuracy</th><th scope="col">Best streak</th></tr></thead><tbody>${rows.join('')}</tbody></table>`;
    $('table-title').textContent = world.phase === 'ended' ? `${TEAMS[world.winner].name} wins` : 'Scoreboard';
    $('table-note').textContent = `Series: KILN ${this.series[0]}, TIDE ${this.series[1]}.`;
  }

  update(dt, world, view, director, brains) {
    if (this.calloutT > 0) {
      this.calloutT -= dt;
      if (this.calloutT <= 0) $('callout').classList.remove('on');
    }
    for (let i = this.feed.length - 1; i >= 0; i--) {
      const item = this.feed[i];
      item.t -= dt;
      if (item.t <= 0) {
        item.li.remove();
        this.feed.splice(i, 1);
      }
    }
    if (!this.visible) return;

    $('score-0').textContent = world.score[0];
    $('score-1').textContent = world.score[1];
    $('clock').textContent = world.phase === 'overtime' ? '0:00' : clock(TIME_LIMIT - world.matchTime);
    $('period').textContent = world.phase === 'overtime' ? 'Sudden death' : world.phase === 'warmup' ? 'Starting' : '';

    const moment = director.replay?.moment;
    const subject = view.bots[moment ? moment.bot : director.shot.a];
    const live = world.bots[subject.id];
    const name = $('player-name');
    name.textContent = live.name;
    name.dataset.team = subject.team;
    const health = $('health');
    const fraction = subject.health / MAX_HEALTH;
    health.style.transform = `scaleX(${fraction})`;
    health.classList.toggle('low', fraction < 0.35);
    $('ammo').textContent = subject.reload > 0 ? 'Reloading' : `${Math.round(subject.ammo)} of ${MAG_SIZE} rounds`;
    $('record').textContent = `${live.kills} ${live.kills === 1 ? 'kill' : 'kills'}, ${live.deaths} ${live.deaths === 1 ? 'death' : 'deaths'}`;
    const rig = director.replay ? director.replay.rig : director.shot.rig;
    $('cam-label').textContent = RIG_LABELS[rig];
    $('lock-note').textContent = director.lockBot >= 0 ? `Following ${live.name}. Press 0 for the director.` : '';

    this.updateMind(subject, brains, live.name);
    this.drawMap(view, director);

    const showTable = this.tableHeld || (world.phase === 'ended' && !director.replay && !director.pending);
    if (showTable) this.renderTable(world);
    $('table').hidden = !showTable;
  }

  updateMind(subject, brains, name) {
    const readout = brains[subject.id]?.readout?.() ?? [];
    $('mind-title').textContent = `Inside ${name}`;
    let top = -1;
    let topValue = -1;
    readout.forEach((r, i) => {
      if (r.value > topValue) {
        topValue = r.value;
        top = i;
      }
    });
    this.mindRows.forEach((row, i) => {
      const r = readout[i];
      row.li.hidden = !r;
      if (!r) return;
      row.label.textContent = r.label;
      row.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, r.value))})`;
      row.li.classList.toggle('top', i === top);
    });
  }

  drawMap(view, director) {
    const g = this.mapCtx;
    const sx = g.canvas.width / MAP_W;
    const sy = g.canvas.height / MAP_H;
    g.drawImage(this.baseMap, 0, 0, g.canvas.width, g.canvas.height);

    if (view.overchargeActive) {
      g.fillStyle = '#ffd23f';
      g.beginPath();
      g.arc(this.arena.overcharge.x * sx, this.arena.overcharge.y * sy, 5, 0, Math.PI * 2);
      g.fill();
    }

    const pos = director.camera.pos;
    const look = director.camera.look;
    const heading = Math.atan2(look[1] - pos[1], look[0] - pos[0]);
    const half = (director.camera.fov * Math.PI) / 360;
    const cx = Math.max(0, Math.min(MAP_W, pos[0])) * sx;
    const cy = Math.max(0, Math.min(MAP_H, pos[1])) * sy;
    g.fillStyle = 'rgb(255 210 63 / 0.26)';
    g.beginPath();
    g.moveTo(cx, cy);
    g.lineTo(cx + Math.cos(heading - half) * 90, cy + Math.sin(heading - half) * 90);
    g.lineTo(cx + Math.cos(heading + half) * 90, cy + Math.sin(heading + half) * 90);
    g.closePath();
    g.fill();

    for (const b of view.bots) {
      if (!b.alive) continue;
      const x = b.x * sx;
      const y = b.y * sy;
      g.fillStyle = TEAMS[b.team].css;
      g.strokeStyle = '#0a1a3f';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(x + Math.cos(b.yaw) * 7, y + Math.sin(b.yaw) * 7);
      g.lineTo(x + Math.cos(b.yaw + 2.4) * 5, y + Math.sin(b.yaw + 2.4) * 5);
      g.lineTo(x + Math.cos(b.yaw - 2.4) * 5, y + Math.sin(b.yaw - 2.4) * 5);
      g.closePath();
      g.fill();
      g.stroke();
    }
  }
}
