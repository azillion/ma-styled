// MA Styled — Hope Core
// Starfield, dawn, HUD, and lesson-based gamification for Math Academy.
// Only runs on /learn* and /courses/* (see manifest).
//
// Persistent state (chrome.storage.local):
//   masHistory: { 'YYYY-MM-DD': { l: lessonsThatDay, r: lessonsRemaining } }
//   masMarks:   { init, units: [names], decile, weekShown }

(() => {
  'use strict';

  const DEFAULTS = {
    enabled: true,
    grain: true,
    stars: true,
    dawn: true,
    hud: true,
    motion: true,
  };

  // The daily mission: new lessons finished today. Reviews, quizzes and
  // assessments don't count — only forward motion.
  const LESSON_GOAL = 6;

  const SITE = {
    completedTasks: '#completedTasks',
    taskCard: '[id^="task-"]',
    completedDateInput: 'input.taskCompletedDate',
    taskType: '.taskTypeLocked, .taskTypeUnlocked',
    xpFrame: '#xpFrame',
    sidebar: '#sidebar',
    courseUnits: '.sequenceCourseUnits',
    unit: '.courseUnit',
  };

  // The site's gem tiers, renamed as an ascent from darkness into light.
  // Edit freely — keys are the site's names.
  const LEAGUES = {
    Diamond: 'The Sun',
    Emerald: 'Dawn',
    Ruby: 'Horizon',
    Sapphire: 'Moonrise',
    Platinum: 'Constellation',
    Gold: 'Starlight',
    Silver: 'Spark',
    Bronze: 'Ember',
    Iron: 'The Void',
  };

  const HUD_LINES = [
    'THE LIGHT GROWS',
    'ONWARD',
    'EVERY PROBLEM A STAR',
    'DAWN IS EARNED',
    'STEEP IS THE WAY UP',
    'SMALL STEPS, VAST SKY',
    'YOU ARE FURTHER THAN YESTERDAY',
  ];

  let settings = { ...DEFAULTS };
  let hist = {};
  let marks = { init: false, units: [], decile: null, weekShown: null };
  let course = { remaining: null, total: null, done: null }; // done: 0..1
  let ready = false;

  let starCanvas = null;
  let starLoop = null;
  let dawnEl = null;
  let hudEl = null;
  let hudTimer = null;
  let missionEl = null;
  let constEl = null;
  let travelerEl = null;

  const prefersStill = matchMedia('(prefers-reduced-motion: reduce)');
  const still = () => !settings.motion || prefersStill.matches;

  // ---- dates ----------------------------------------------------------

  const dkey = (d = new Date()) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate()
    ).padStart(2, '0')}`;

  const daysAgo = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d;
  };

  // "Wed, Jul 1st, 2026" → "2026-07-01"; "Today" → today's key
  function parseSiteDate(value) {
    if (value === 'Today') return dkey();
    const d = new Date(value.replace(/^[A-Za-z]+,\s*/, '').replace(/(\d+)(st|nd|rd|th)/, '$1'));
    return isNaN(d) ? null : dkey(d);
  }

  // ---- reading the page -----------------------------------------------

  // { 'YYYY-MM-DD': lessonCount } from the completed-tasks list, or null
  // when this page has no dashboard (e.g. /courses/*).
  function lessonsByDate() {
    const container = document.querySelector(SITE.completedTasks);
    if (!container) return null;
    const byDate = {};
    for (const card of container.querySelectorAll(SITE.taskCard)) {
      const key = parseSiteDate(card.querySelector(SITE.completedDateInput)?.value ?? '');
      if (!key) continue;
      byDate[key] ??= 0;
      if (card.querySelector(SITE.taskType)?.textContent.trim() === 'Lesson') byDate[key]++;
    }
    return byDate;
  }

  function countLessonsToday() {
    const byDate = lessonsByDate();
    return byDate ? byDate[dkey()] ?? 0 : null;
  }

  // Units of the selected course: name, topic count, and the fraction of
  // topics not yet started (the white bar segment's inline width).
  function readCourse() {
    const units = [];
    for (const unit of document.querySelectorAll(`${SITE.courseUnits} ${SITE.unit}`)) {
      if (unit.closest(SITE.courseUnits)?.style.display === 'none') continue;
      const m = unit.textContent.match(/([^()]+?)\s*\((\d+)\s+topics?\)/);
      if (!m) continue;
      const white = [...unit.querySelectorAll('td')].find((td) =>
        (td.getAttribute('style') || '').includes('background-color: white')
      );
      const pct = white ? parseFloat(white.style.width) : NaN;
      if (!isFinite(pct)) continue;
      units.push({ name: m[1].replace(/^\d+\.\s*/, '').trim(), topics: +m[2], whitePct: pct });
    }
    if (!units.length) return null;
    const total = units.reduce((s, u) => s + u.topics, 0);
    const remaining = Math.round(units.reduce((s, u) => s + (u.topics * u.whitePct) / 100, 0));
    return { units, total, remaining, done: total ? 1 - remaining / total : 0 };
  }

  // ---- history ----------------------------------------------------------

  // Runs on load and on every observer tick (the dashboard hydrates late),
  // persisting only when something actually changed.
  function absorb() {
    const today = dkey();
    let changed = false;

    const byDate = lessonsByDate();
    if (byDate) {
      // counts only ever grow within a day; max() also protects against
      // reading the list mid-hydration
      for (const [key, count] of Object.entries(byDate)) {
        if (count > (hist[key]?.l ?? 0)) {
          hist[key] = { ...hist[key], l: count };
          changed = true;
        }
      }
    }

    const c = readCourse();
    if (c) {
      // The unit bars round to whole percents, so single lessons often
      // don't move their estimate. Anchor to the bars but decrement by our
      // own exact lesson counts: remaining ticks down 1 per lesson, and
      // re-anchors whenever the site's estimate drops below the model.
      let est = c.remaining;
      const prevKey = Object.keys(hist)
        .filter((k) => k < today && hist[k]?.r != null)
        .sort()
        .pop();
      if (prevKey) {
        let since = 0;
        for (const [k, v] of Object.entries(hist)) {
          if (k > prevKey && k <= today) since += v.l ?? 0;
        }
        est = Math.min(est, hist[prevKey].r - since);
      }
      if (hist[today]?.r != null) est = Math.min(est, hist[today].r);
      est = Math.max(0, est);

      course = { ...c, remaining: est, done: c.total ? 1 - est / c.total : c.done };
      if (hist[today]?.r !== est) {
        hist[today] = { ...hist[today], r: est };
        changed = true;
      }
    } else if (course.done === null) {
      // no units on this page — fall back to the latest recorded snapshot
      const latest = Object.keys(hist).sort().reverse().find((k) => hist[k]?.r != null);
      if (latest) course = { remaining: hist[latest].r, total: null, done: null };
    }

    if (changed) persist();
  }

  function persist() {
    chrome.storage.local.set({ masHistory: hist, masMarks: marks });
  }

  // One round-trip to the private sync server (see server/): our state is
  // merged in and the combined state comes back. Runs before celebrations
  // so events fired in another browser don't repeat here. Unconfigured or
  // offline → stays local.
  let synced = false;
  async function syncWithServer() {
    if (synced) return;
    synced = true;
    try {
      const merged = await chrome.runtime.sendMessage({
        type: 'mas-sync',
        history: hist,
        marks,
      });
      if (merged?.history) {
        hist = merged.history;
        if (merged.marks) marks = merged.marks;
        persist();
      }
    } catch {
      // service worker asleep/unreachable — local state is fine
    }
  }

  const lessonsOn = (key) => hist[key]?.l ?? 0;

  // mean lessons/day over the 7 full days before today (missing = 0);
  // aspirational LESSON_GOAL when there's no history yet
  function pace() {
    const keys = Array.from({ length: 7 }, (_, i) => dkey(daysAgo(i + 1)));
    if (!keys.some((k) => hist[k])) return LESSON_GOAL;
    return keys.reduce((s, k) => s + lessonsOn(k), 0) / 7;
  }

  // consecutive goal-met days ending today (or yesterday, while today is
  // still in progress)
  function streak() {
    let n = 0;
    let i = lessonsOn(dkey()) >= LESSON_GOAL ? 0 : 1;
    while (lessonsOn(dkey(daysAgo(i))) >= LESSON_GOAL) {
      n++;
      i++;
    }
    return n;
  }

  // ---- starfield --------------------------------------------------------
  // Density grows with course completion: the sky fills as the course
  // empties. Lessons beyond today's goal add warm stars.

  function makeStars() {
    const c = document.createElement('canvas');
    c.className = 'mas-stars';
    document.body.appendChild(c);
    const ctx = c.getContext('2d');
    let stars = [];
    let shooting = null;
    let nextShootAt = performance.now() + 30e3 + Math.random() * 60e3;

    function seed() {
      c.width = innerWidth * devicePixelRatio;
      c.height = innerHeight * devicePixelRatio;
      const doneFrac = course.done ?? 0.2;
      const n = Math.round(((innerWidth * innerHeight) / 5200) * (0.55 + 0.95 * doneFrac));
      stars = Array.from({ length: n }, () => {
        const roll = Math.random();
        return {
          x: Math.random() * c.width,
          y: Math.random() * c.height,
          r: (0.35 + Math.random() * 1.05) * devicePixelRatio,
          base: 0.25 + Math.random() * 0.65,
          phase: Math.random() * Math.PI * 2,
          speed: 0.3 + Math.random() * 0.9,
          color: roll < 0.05 ? '255, 201, 138' : roll < 0.1 ? '159, 195, 255' : '233, 233, 228',
        };
      });
      // beyond the sun: one bright warm star per lesson past the goal
      const extra = Math.max(0, (countLessonsToday() ?? 0) - LESSON_GOAL);
      for (let i = 0; i < extra; i++) {
        stars.push({
          x: Math.random() * c.width,
          y: Math.random() * c.height * 0.5,
          r: 1.6 * devicePixelRatio,
          base: 0.95,
          phase: Math.random() * Math.PI * 2,
          speed: 0.25,
          color: '255, 201, 138',
        });
      }
    }

    function draw(t) {
      ctx.clearRect(0, 0, c.width, c.height);
      for (const s of stars) {
        const tw = still() ? 1 : 0.72 + 0.28 * Math.sin(s.phase + (t / 1000) * s.speed);
        ctx.fillStyle = `rgba(${s.color}, ${s.base * tw})`;
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fill();
      }

      // a rare rising streak of light — hope going up, not falling down
      if (!still()) {
        if (!shooting && t > nextShootAt) {
          shooting = { x: c.width * (0.15 + Math.random() * 0.7), y: c.height * 1.05, born: t };
          nextShootAt = t + 40e3 + Math.random() * 80e3;
        }
        if (shooting) {
          const age = (t - shooting.born) / 2600;
          if (age >= 1) {
            shooting = null;
          } else {
            const y = shooting.y - age * c.height * 1.25;
            const grad = ctx.createLinearGradient(0, y, 0, y + 140 * devicePixelRatio);
            grad.addColorStop(0, 'rgba(255,255,255,0)');
            grad.addColorStop(0.5, `rgba(255,255,255,${0.8 * Math.sin(age * Math.PI)})`);
            grad.addColorStop(1, 'rgba(255,255,255,0)');
            ctx.fillStyle = grad;
            ctx.fillRect(shooting.x, y, 1.5 * devicePixelRatio, 140 * devicePixelRatio);
          }
        }
      }

      starLoop = still() ? null : requestAnimationFrame(draw);
    }

    seed();
    draw(performance.now());
    addEventListener('resize', seed, { passive: true });
    return c;
  }

  // ---- dawn -------------------------------------------------------------

  function updateDawn() {
    let p;
    const today = countLessonsToday();
    if (today !== null) {
      p = Math.min(today / LESSON_GOAL, 1);
      sessionStorage.setItem('mas-progress', String(p));
    } else {
      const saved = parseFloat(sessionStorage.getItem('mas-progress'));
      p = isFinite(saved) ? saved : null;
    }
    document.documentElement.toggleAttribute('data-mas-goal-met', p !== null && p >= 1);
    // Faint pre-dawn glow even at zero progress: hope is never off.
    const value = p === null ? 0.12 : 0.12 + p * 0.88;
    document.documentElement.style.setProperty('--mas-progress', value.toFixed(3));
  }

  // ---- the traveler ------------------------------------------------------
  // A tiny figure on the horizon, walking from the left edge toward the
  // dawn at center. Position = course completion.

  function updateTraveler() {
    if (!settings.dawn) return;
    if (!travelerEl || !travelerEl.isConnected) {
      travelerEl = document.createElement('div');
      travelerEl.className = 'mas-traveler';
      travelerEl.title = 'you';
      document.body.appendChild(travelerEl);
    }
    const done = course.done ?? (course.total ? 1 - course.remaining / course.total : 0.2);
    travelerEl.style.left = `${(4 + 46 * Math.min(done ?? 0.2, 1)).toFixed(2)}vw`;
  }

  // ---- mission widget ----------------------------------------------------

  function updateMission() {
    const host = document.querySelector(SITE.xpFrame);
    const today = countLessonsToday();
    if (!host || today === null) return;

    if (!missionEl || !missionEl.isConnected) {
      missionEl = document.createElement('div');
      missionEl.className = 'mas-mission';
      missionEl.innerHTML = `
        <div class="mas-mission-header">TODAY'S ASCENT</div>
        <div class="mas-mission-dots">${'<span class="mas-mission-dot"></span>'.repeat(LESSON_GOAL)}</div>
        <div class="mas-mission-count"></div>
        <div class="mas-week"></div>
        <div class="mas-mission-left"></div>
        <div class="mas-mission-eta"></div>`;
      host.appendChild(missionEl);
    }

    // only write on change — our own writes would retrigger the observer
    const setText = (sel, text) => {
      const el = missionEl.querySelector(sel);
      if (el.textContent !== text) el.textContent = text;
    };

    missionEl
      .querySelectorAll('.mas-mission-dot')
      .forEach((dot, i) => dot.classList.toggle('lit', i < today));
    setText(
      '.mas-mission-count',
      today >= LESSON_GOAL
        ? `${today}/${LESSON_GOAL} · THE SUN IS UP`
        : `${today}/${LESSON_GOAL} LESSONS`
    );

    // last 7 days as columns of six dots, growing from the bottom
    const week = missionEl.querySelector('.mas-week');
    const cols = Array.from({ length: 7 }, (_, i) => {
      const d = daysAgo(6 - i);
      const count = i === 6 ? today : lessonsOn(dkey(d));
      return { letter: 'SMTWTFS'[d.getDay()], count };
    });
    const sig = JSON.stringify(cols);
    if (week.dataset.sig !== sig) {
      week.dataset.sig = sig;
      week.innerHTML = cols
        .map(({ letter, count }) => {
          const dots = Array.from({ length: LESSON_GOAL }, (_, row) => {
            const lit = LESSON_GOAL - row <= Math.min(count, LESSON_GOAL);
            const warm = lit && count > LESSON_GOAL && row === 0;
            return `<span class="mas-week-dot${lit ? ' lit' : ''}${warm ? ' warm' : ''}"></span>`;
          }).join('');
          return `<span class="mas-week-col">${dots}<span class="mas-week-day">${letter}</span></span>`;
        })
        .join('');
    }

    setText(
      '.mas-mission-left',
      course.remaining === null ? '' : `≈ ${course.remaining} LESSONS LEFT IN COURSE`
    );

    let eta = '';
    if (course.remaining !== null) {
      const rate = pace();
      if (rate > 0) {
        const days = Math.ceil(course.remaining / rate);
        const arrive = daysAgo(-days)
          .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
          .toUpperCase();
        eta = `AT ${rate.toFixed(1)}/DAY · ARRIVE ${arrive}`;
      }
    }
    setText('.mas-mission-eta', eta);
  }

  // ---- constellation ------------------------------------------------------
  // One star per day this month with lessons; goal-met days shine bright,
  // and consecutive goal-met days are joined into a constellation.

  function starSpot(y, m, d, w, h, margin) {
    let s = (y * 372 + m * 31 + d) * 2654435761;
    const rnd = () => {
      s = Math.imul(s ^ (s >>> 15), 2246822519);
      s = Math.imul(s ^ (s >>> 13), 3266489917);
      return ((s ^= s >>> 16) >>> 0) / 4294967296;
    };
    return { x: margin + rnd() * (w - margin * 2), y: margin + rnd() * (h - margin * 2) };
  }

  function updateConstellation() {
    const xpFrame = document.querySelector(SITE.xpFrame);
    if (!xpFrame) return;

    if (!constEl || !constEl.isConnected) {
      constEl = document.createElement('div');
      constEl.className = 'sidebarFrame mas-constellation';
      constEl.innerHTML = `
        <div class="mas-constellation-label">THE MONTH'S SKY</div>
        <canvas></canvas>
        <div class="mas-constellation-streak"></div>`;
      xpFrame.insertAdjacentElement('afterend', constEl);
    }

    // the site sizes sidebar cards via id-specific rules our div doesn't
    // get — mirror the XP card's outer width exactly
    constEl.style.boxSizing = 'border-box';
    constEl.style.width = `${xpFrame.offsetWidth}px`;

    const canvas = constEl.querySelector('canvas');
    // inline so no site rule can stretch the canvas to its attribute size
    canvas.style.cssText = 'display:block;width:100%;height:110px;';
    const dpr = devicePixelRatio;
    const w = (canvas.clientWidth || 280) * dpr;
    const h = 110 * dpr;
    const sig = `${w}:${JSON.stringify(hist)}`;
    if (canvas.dataset.sig === sig) return;
    canvas.dataset.sig = sig;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');

    const now = new Date();
    const [y, m, todayDate] = [now.getFullYear(), now.getMonth(), now.getDate()];
    const days = Array.from({ length: todayDate }, (_, i) => {
      const d = i + 1;
      const l = lessonsOn(dkey(new Date(y, m, d)));
      return { d, l, ...starSpot(y, m, d, w, h, 12 * dpr) };
    });

    // constellation lines between consecutive goal-met days
    ctx.strokeStyle = 'rgba(233, 233, 228, 0.22)';
    ctx.lineWidth = dpr * 0.75;
    for (let i = 0; i < days.length - 1; i++) {
      const a = days[i];
      const b = days[i + 1];
      if (a.l >= LESSON_GOAL && b.l >= LESSON_GOAL) {
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
    }

    for (const day of days) {
      if (day.l <= 0) continue;
      const bright = day.l >= LESSON_GOAL;
      ctx.save();
      ctx.shadowColor = 'rgba(255,255,255,0.8)';
      ctx.shadowBlur = bright ? 7 * dpr : 0;
      ctx.fillStyle = bright ? 'rgba(255,255,255,0.95)' : 'rgba(233,233,228,0.32)';
      ctx.beginPath();
      ctx.arc(day.x, day.y, (bright ? 2.1 : 1.1) * dpr, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    const n = streak();
    const label = constEl.querySelector('.mas-constellation-streak');
    const text = n > 0 ? `${n} ${n === 1 ? 'NIGHT' : 'NIGHTS'} ALIGHT` : 'THE SKY AWAITS';
    if (label.textContent !== text) label.textContent = text;
  }

  // ---- league renaming -------------------------------------------------
  // Rewritten text stops matching the site names, so repeat runs (and the
  // mutation they cause) are no-ops.

  const LEAGUE_RE = new RegExp(`\\b(${Object.keys(LEAGUES).join('|')})\\s+League\\b`);

  function renameLeagues() {
    for (const el of document.querySelectorAll('#leaderboardLeagueName, .leagueLevelName')) {
      const renamed = el.textContent.replace(LEAGUE_RE, (_, name) => LEAGUES[name]);
      if (renamed !== el.textContent) el.textContent = renamed;
    }
  }

  // ---- HUD ------------------------------------------------------------

  function rotateHud() {
    if (!hudEl) return;
    const line = HUD_LINES[Math.floor(Math.random() * HUD_LINES.length)];
    hudEl.style.opacity = '0';
    setTimeout(() => {
      hudEl.textContent = `· ${line} ·`;
      hudEl.style.opacity = '1';
    }, 1600);
  }

  function say(line) {
    if (hudEl) hudEl.textContent = `· ${line} ·`;
  }

  // ---- celebrations ------------------------------------------------------

  function ascend(el, xOffset = 0, warm = false) {
    if (still()) return;
    const rect = el?.getBoundingClientRect?.();
    const streakEl = document.createElement('div');
    streakEl.className = `mas-ascend${warm ? ' warm' : ''}`;
    streakEl.style.left = `${(rect ? rect.left + rect.width / 2 : innerWidth / 2) + xOffset}px`;
    streakEl.style.top = `${rect ? rect.top : innerHeight * 0.6}px`;
    document.body.appendChild(streakEl);
    setTimeout(() => streakEl.remove(), 2000);
  }
  window.masAscend = ascend;

  // one rising streak per lesson finished since the last visit today;
  // lessons past the goal rise warm
  let checkedLessons = false;
  function celebrateLessons() {
    if (checkedLessons) return;
    const today = countLessonsToday();
    if (today === null) return;
    checkedLessons = true;

    const key = `mas-lessons:${dkey()}`;
    const last = parseFloat(localStorage.getItem(key));
    for (const k of Object.keys(localStorage)) {
      if ((k.startsWith('mas-lessons:') || k.startsWith('mas-xp:')) && k !== key) {
        localStorage.removeItem(k);
      }
    }
    // never lower the baseline — a mid-hydration undercount would replay
    // the same streaks on the next load
    if (!isFinite(last) || today > last) localStorage.setItem(key, String(today));
    if (!isFinite(last) || today <= last) return;

    const anchor = missionEl ?? document.querySelector(SITE.xpFrame);
    const count = Math.min(8, today - last);
    for (let i = 0; i < count; i++) {
      const lessonNumber = last + i + 1;
      setTimeout(
        () => ascend(anchor, (Math.random() - 0.5) * 160, lessonNumber > LESSON_GOAL),
        500 + i * 450
      );
    }
  }

  // unit summits: a meteor shower the first time a unit's lessons are done
  let checkedSummits = false;
  function celebrateSummits() {
    if (checkedSummits || !course.units) return;
    checkedSummits = true;

    const finished = course.units.filter((u) => u.whitePct === 0).map((u) => u.name);
    if (!marks.init) return; // first ever run seeds silently (via checkMarksInit)
    const fresh = finished.filter((name) => !marks.units.includes(name));
    if (!fresh.length) return;
    marks.units = [...new Set([...marks.units, ...finished])];
    persist();

    const left = course.units.filter((u) => u.whitePct > 0).length;
    say(`${fresh[fresh.length - 1].toUpperCase()} BEHIND YOU · ${left} REMAIN`);
    for (let i = 0; i < 7; i++) {
      setTimeout(() => ascend(null, (Math.random() - 0.5) * innerWidth * 0.8), 300 + i * 260);
    }
  }

  // milestone flare each time another tenth of the course is done
  let checkedDecile = false;
  function celebrateDecile() {
    if (checkedDecile || course.done === null) return;
    checkedDecile = true;
    const decile = Math.floor(course.done * 10);
    if (!marks.init) return;
    if (marks.decile !== null && decile > marks.decile) {
      say('ONE TENTH CLOSER TO THE SUN');
      const flare = document.createElement('div');
      flare.className = 'mas-flare';
      document.body.appendChild(flare);
      setTimeout(() => flare.remove(), 5000);
    }
    if (decile !== marks.decile) {
      marks.decile = decile;
      persist();
    }
  }

  // first load of each week: a quiet report on the week before
  let checkedWeek = false;
  function weeklyTransmission() {
    if (checkedWeek) return;
    checkedWeek = true;

    const monday = new Date();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const weekKey = dkey(monday);
    if (marks.weekShown === weekKey || !marks.init) {
      if (marks.weekShown !== weekKey) {
        marks.weekShown = weekKey;
        persist();
      }
      return;
    }
    marks.weekShown = weekKey;
    persist();

    const lastWeek = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(monday);
      d.setDate(d.getDate() - 7 + i);
      return d;
    });
    const counts = lastWeek.map((d) => ({ d, l: lessonsOn(dkey(d)) }));
    const total = counts.reduce((s, c) => s + c.l, 0);
    if (total === 0) return; // nothing to report

    const alight = counts.filter((c) => c.l >= LESSON_GOAL).length;
    const best = counts.reduce((a, b) => (b.l > a.l ? b : a));
    const bestDay = best.d.toLocaleDateString('en-US', { weekday: 'long' }).toUpperCase();

    const box = document.createElement('div');
    box.className = 'mas-transmission';
    box.innerHTML = `
      <div class="mas-transmission-title">WEEKLY TRANSMISSION</div>
      <div class="mas-transmission-line">${total} ${total === 1 ? 'LESSON' : 'LESSONS'} · ${alight} ${
        alight === 1 ? 'DAY' : 'DAYS'
      } ALIGHT</div>
      <div class="mas-transmission-line dim">BRIGHTEST: ${bestDay} (${best.l})</div>
      <div class="mas-transmission-line dim">THE SKY GAINED ${total} STARS</div>
      <div class="mas-transmission-btn">ONWARD</div>`;
    box.querySelector('.mas-transmission-btn').addEventListener('click', () => box.remove());
    document.body.appendChild(box);
  }

  // seed marks on the very first run so pre-existing progress
  // doesn't trigger a celebration barrage
  function checkMarksInit() {
    // wait until the units have actually rendered — initializing against a
    // half-hydrated page would arm every already-finished unit to
    // "complete" itself later
    if (marks.init || !course.units) return;
    marks.units = course.units.filter((u) => u.whitePct === 0).map((u) => u.name);
    marks.decile = course.done !== null ? Math.floor(course.done * 10) : null;
    marks.init = true;
    persist();
  }

  // ---- lifecycle --------------------------------------------------------

  async function mount() {
    absorb();
    checkMarksInit();

    if (!settings.stars) {
      if (starLoop) cancelAnimationFrame(starLoop);
      starCanvas?.remove();
      starCanvas = null;
      starLoop = null;
    } else if (!starCanvas) {
      starCanvas = makeStars();
    }

    if (!settings.dawn) {
      dawnEl?.remove();
      travelerEl?.remove();
      dawnEl = travelerEl = null;
    } else {
      if (!dawnEl) {
        dawnEl = document.createElement('div');
        dawnEl.className = 'mas-dawn';
        document.body.appendChild(dawnEl);
      }
      updateTraveler();
    }

    if (!settings.hud) {
      clearInterval(hudTimer);
      hudEl?.remove();
      hudEl = null;
      hudTimer = null;
    } else if (!hudEl) {
      hudEl = document.createElement('div');
      hudEl.className = 'mas-hud';
      hudEl.textContent = `· ${HUD_LINES[0]} ·`;
      document.body.appendChild(hudEl);
      hudTimer = setInterval(rotateHud, 45e3);
    }

    // render immediately from local state, then reconcile with the server
    // and re-render before any celebration fires
    updateMission();
    updateConstellation();
    updateDawn();
    renameLeagues();

    await syncWithServer();
    updateMission();
    updateConstellation();
    updateDawn();

    // let the dashboard finish hydrating before reading celebration
    // baselines (all four are one-shot guarded, so re-mounts are no-ops)
    setTimeout(() => {
      absorb();
      checkMarksInit();
      celebrateLessons();
      celebrateSummits();
      celebrateDecile();
      weeklyTransmission();
    }, 1800);
  }

  function unmount() {
    if (starLoop) cancelAnimationFrame(starLoop);
    clearInterval(hudTimer);
    document.querySelector('.mas-transmission')?.remove();
    for (const el of [starCanvas, dawnEl, hudEl, missionEl, constEl, travelerEl]) el?.remove();
    starCanvas = dawnEl = hudEl = missionEl = constEl = travelerEl = starLoop = hudTimer = null;
  }

  function applySettings(s) {
    settings = s;
    if (!ready) return;
    if (settings.enabled) mount();
    else unmount();
  }

  async function init() {
    const [syncVals, localVals] = await Promise.all([
      chrome.storage.sync.get(DEFAULTS),
      chrome.storage.local.get({ masHistory: {}, masMarks: null }),
    ]);
    hist = localVals.masHistory ?? {};
    marks = localVals.masMarks ?? { init: false, units: [], decile: null, weekShown: null };
    ready = true;
    applySettings(syncVals);
  }
  init();

  chrome.storage.onChanged.addListener((_c, area) => {
    if (area === 'sync') chrome.storage.sync.get(DEFAULTS, applySettings);
  });

  // Keep the widgets fresh if the page mutates (dialogs, answer review).
  let tickPending = false;
  const observer = new MutationObserver(() => {
    if (tickPending || !settings.enabled || !ready) return;
    tickPending = true;
    requestAnimationFrame(() => {
      tickPending = false;
      absorb(); // the dashboard hydrates late — keep course data fresh
      updateMission();
      updateConstellation();
      updateTraveler();
      updateDawn();
      renameLeagues();
    });
  });
  observer.observe(document.documentElement, {
    subtree: true,
    childList: true,
    characterData: true,
  });
})();
