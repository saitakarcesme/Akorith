import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  executeLocalExecutorAttempt,
  type LocalExecutorAction
} from '../src/main/local-executor'
import { requestedGameFeatureGaps } from '../src/main/local-executor-quality'
import {
  localGenerationStopReason,
  sendWorkspaceLocal
} from '../src/main/providers/local-workspace'
import type {
  Provider,
  ProviderActivity,
  SendOptions,
  SendResult
} from '../src/main/providers/types'

const GOAL =
  'Build a complete playable single-page browser game in this empty folder called Call of Duty: Akorith Ops. Use only index.html, styles.css, and game.js with no packages or external dependencies. Include Start and Restart controls, WASD movement, mouse and touch aim and fire, moving enemies, score, health, ammo and reload, game-over, and a responsive layout. Use only original canvas and CSS visuals with no external assets or network calls. Do the work now, verify game.js, and open the completed game in Akorith Browser. Do not stop at a plan or explanation.'

function action(files: Array<{ path: string; content: string }>, summary: string): string {
  return JSON.stringify({
    type: 'workspace_patch',
    summary,
    rationale: 'Fulfill the requested game inside the bounded workspace.',
    files: files.map((file) => ({
      path: file.path,
      operation: 'create',
      content: file.content
    })),
    commands: [],
    expected_outcome: 'The requested game files exist and JavaScript syntax validation passes.'
  })
}

const STUB = action(
  [
    {
      path: 'index.html',
      content:
        '<!doctype html><html><body><canvas id="gameCanvas"></canvas><script src="game.js"></script></body></html>'
    },
    {
      path: 'styles.css',
      content: 'canvas { width: 100%; height: 100vh; background: #000; }'
    },
    {
      path: 'game.js',
      content:
        "// JavaScript code will go here\nconst canvas = document.getElementById('gameCanvas');\nfunction gameLoop() {\n  // Game logic goes here\n  requestAnimationFrame(gameLoop);\n}\nrequestAnimationFrame(gameLoop);\n"
    }
  ],
  'Create the requested files with basic structure'
)

const COMPLETE_GAME_JS = `
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const startButton = document.getElementById('start');
const restartButton = document.getElementById('restart');
const hud = document.getElementById('hud');
const state = {
  running: false,
  score: 0,
  health: 100,
  ammo: 30,
  player: { x: 320, y: 240, speed: 4 },
  pointer: { x: 320, y: 200, firing: false },
  keys: new Set(),
  enemies: []
};
function resize() {
  canvas.width = Math.max(640, canvas.clientWidth);
  canvas.height = Math.max(360, canvas.clientHeight);
}
function reset() {
  state.running = true;
  state.score = 0;
  state.health = 100;
  state.ammo = 30;
  state.player.x = canvas.width / 2;
  state.player.y = canvas.height / 2;
  state.enemies = Array.from({ length: 8 }, (_, index) => ({
    x: 40 + index * 70,
    y: 50 + (index % 3) * 90,
    speed: 0.5 + index * 0.05
  }));
  restartButton.hidden = true;
}
function movePlayer() {
  if (state.keys.has('w')) state.player.y -= state.player.speed;
  if (state.keys.has('s')) state.player.y += state.player.speed;
  if (state.keys.has('a')) state.player.x -= state.player.speed;
  if (state.keys.has('d')) state.player.x += state.player.speed;
  state.player.x = Math.max(15, Math.min(canvas.width - 15, state.player.x));
  state.player.y = Math.max(15, Math.min(canvas.height - 15, state.player.y));
}
function updateEnemies() {
  for (const enemy of state.enemies) {
    const dx = state.player.x - enemy.x;
    const dy = state.player.y - enemy.y;
    const distance = Math.max(1, Math.hypot(dx, dy));
    enemy.x += (dx / distance) * enemy.speed;
    enemy.y += (dy / distance) * enemy.speed;
    if (distance < 24) state.health = Math.max(0, state.health - 0.2);
  }
}
function fire() {
  if (!state.pointer.firing || state.ammo <= 0) return;
  state.ammo -= 1;
  let closest = -1;
  let distance = 70;
  state.enemies.forEach((enemy, index) => {
    const hitDistance = Math.hypot(enemy.x - state.pointer.x, enemy.y - state.pointer.y);
    if (hitDistance < distance) {
      closest = index;
      distance = hitDistance;
    }
  });
  if (closest >= 0) {
    state.enemies.splice(closest, 1);
    state.score += 100;
  }
  state.pointer.firing = false;
}
function draw() {
  ctx.fillStyle = '#08111d';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#63e6be';
  ctx.beginPath();
  ctx.arc(state.player.x, state.player.y, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ff6b6b';
  for (const enemy of state.enemies) ctx.fillRect(enemy.x - 11, enemy.y - 11, 22, 22);
  hud.textContent = \`Score \${state.score} · Health \${Math.ceil(state.health)} · Ammo \${state.ammo}/30\`;
}
function frame() {
  if (state.running) {
    movePlayer();
    updateEnemies();
    fire();
    draw();
    if (state.health <= 0 || state.enemies.length === 0) {
      state.running = false;
      restartButton.hidden = false;
    }
  }
  requestAnimationFrame(frame);
}
function point(event) {
  const rect = canvas.getBoundingClientRect();
  const source = event.touches?.[0] ?? event;
  state.pointer.x = ((source.clientX - rect.left) / rect.width) * canvas.width;
  state.pointer.y = ((source.clientY - rect.top) / rect.height) * canvas.height;
}
window.addEventListener('keydown', (event) => {
  const key = event.key.toLowerCase();
  state.keys.add(key);
  if (key === 'r') state.ammo = 30;
});
window.addEventListener('keyup', (event) => state.keys.delete(event.key.toLowerCase()));
canvas.addEventListener('pointermove', point);
canvas.addEventListener('pointerdown', (event) => { point(event); state.pointer.firing = true; });
canvas.addEventListener('touchstart', (event) => { point(event); state.pointer.firing = true; }, { passive: true });
startButton.addEventListener('click', reset);
restartButton.addEventListener('click', reset);
window.addEventListener('resize', resize);
resize();
draw();
requestAnimationFrame(frame);
`.trim()

const COMPLETE = action(
  [
    {
      path: 'index.html',
      content:
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="styles.css"></head><body><main><h1>Call of Duty: Akorith Ops</h1><div id="hud"></div><canvas id="gameCanvas"></canvas><div class="controls"><button id="start">Start</button><button id="restart" hidden>Restart</button><span>WASD · Mouse/touch fire · R reload</span></div></main><script src="game.js"></script></body></html>'
    },
    {
      path: 'styles.css',
      content:
        'html,body{margin:0;min-height:100%;background:#07101c;color:#eef;font:16px system-ui}main{width:min(100%,1100px);margin:auto;padding:clamp(10px,2vw,24px);box-sizing:border-box}canvas{display:block;width:100%;height:min(70vh,680px);border:1px solid #2d4159;border-radius:10px;background:#08111d;touch-action:none}.controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:12px}button{border:0;border-radius:999px;padding:10px 20px;font-weight:700}@media(max-width:640px){canvas{height:62vh}.controls span{font-size:13px}}'
    },
    { path: 'game.js', content: COMPLETE_GAME_JS }
  ],
  'Build the complete playable Call of Duty: Akorith Ops browser game'
)

const SHALLOW_NON_PLACEHOLDER = action(
  [
    {
      path: 'index.html',
      content:
        '<!doctype html><html><body><canvas id="gameCanvas"></canvas><script src="game.js"></script></body></html>'
    },
    {
      path: 'styles.css',
      content: 'html,body,canvas{margin:0;width:100%;height:100%;background:#05080d}'
    },
    {
      path: 'game.js',
      content: [
        "const canvas=document.getElementById('gameCanvas');",
        "const ctx=canvas.getContext('2d');",
        'function frame(){ctx.fillRect(0,0,canvas.width,canvas.height);requestAnimationFrame(frame)}',
        'requestAnimationFrame(frame);',
        ...Array.from({ length: 150 }, (_, index) => `const visualMarker${index}=${index};`)
      ].join('\n')
    }
  ],
  'Render a decorative military canvas'
)

class FakeLocalProvider implements Provider {
  readonly id = 'local'
  readonly label = 'Fake Local'
  readonly kind: Provider['kind'] = ['chat', 'executor']
  readonly prompts: string[] = []
  readonly options: SendOptions[] = []
  private call = 0

  constructor(
    private readonly outputs: string[],
    private readonly onCall?: (call: number) => void,
    private readonly doneReasons: Array<string | undefined> = []
  ) {}

  async isAvailable() {
    return { ok: true }
  }

  async listModels() {
    return ['fixture']
  }

  async send(
    prompt: string,
    opts: SendOptions,
    onToken: (token: string) => void
  ): Promise<SendResult> {
    this.call += 1
    this.onCall?.(this.call)
    this.prompts.push(prompt)
    this.options.push(opts)
    const index = Math.min(this.call - 1, this.outputs.length - 1)
    onToken(this.outputs[index])
    return {
      text: this.outputs[index],
      usage: {
        promptTokens: this.call * 10,
        completionTokens: this.call * 5,
        totalTokens: this.call * 15,
        costUsd: 0,
        estimated: false
      },
      model: 'fixture',
      raw: this.doneReasons[index]
        ? { done_reason: this.doneReasons[index] }
        : undefined
    }
  }
}

async function main(): Promise<void> {
  assert.equal(
    localGenerationStopReason({ done_reason: 'length' }),
    'length',
    'Ollama output-limit completion is identified before parsing a partial patch'
  )
  assert.equal(
    localGenerationStopReason({ done_reason: 'stop' }),
    'stop',
    'normal Ollama completion remains distinguishable from truncation'
  )
  assert.equal(
    localGenerationStopReason(null),
    null,
    'non-Ollama provider metadata does not manufacture a stop reason'
  )
  const completeAction = JSON.parse(COMPLETE) as LocalExecutorAction
  assert.deepEqual(
    requestedGameFeatureGaps(GOAL, completeAction),
    [],
    'a fully wired playable fixture satisfies every requested game feature'
  )
  const aliasedAction = JSON.parse(
    JSON.stringify(completeAction)
      .replaceAll('enemies', 'foes')
      .replaceAll('enemy', 'foe')
      .replaceAll('health', 'hp')
      .replaceAll('ammo', 'magazine')
      .replaceAll('fire', 'attack')
  ) as LocalExecutorAction
  assert.deepEqual(
    requestedGameFeatureGaps(GOAL, aliasedAction),
    [],
    'equivalent gameplay is accepted when valid code uses different identifier names'
  )

  const shallowAction = JSON.parse(STUB) as LocalExecutorAction
  const shallowGaps = requestedGameFeatureGaps(GOAL, shallowAction)
  for (const expectedGap of [
    'wired Start control',
    'wired Restart control',
    'WASD movement',
    'mouse aim',
    'touch input',
    'implemented firing',
    'moving enemies',
    'score progression',
    'health damage/recovery',
    'ammo consumption',
    'reload behavior',
    'game-over state',
    'responsive resizing'
  ]) {
    assert.ok(
      shallowGaps.includes(expectedGap),
      `a shallow canvas scaffold is rejected for missing ${expectedGap}`
    )
  }

  const decorativeControls = JSON.parse(
    action(
      [
        {
          path: 'index.html',
          content:
            '<button id="start">Start</button><button id="restart">Restart</button><canvas id="gameCanvas"></canvas><script src="game.js"></script>'
        },
        {
          path: 'styles.css',
          content: '@media(max-width:640px){canvas{width:100%}}'
        },
        {
          path: 'game.js',
          content:
            "const player={x:0,y:0}; const enemy={x:0,y:0}; const keys=['w','a','s','d']; window.addEventListener('keydown',()=>{player.x+=1});"
        }
      ],
      'Render decorative controls without wiring them'
    )
  ) as LocalExecutorAction
  const decorativeGaps = requestedGameFeatureGaps(GOAL, decorativeControls)
  assert.ok(
    decorativeGaps.includes('wired Start control') &&
      decorativeGaps.includes('wired Restart control'),
    'button labels without click behavior do not pass the gameplay gate'
  )

  const genericShooterGaps = requestedGameFeatureGaps(
    'Build a Call of Duty browser game.',
    JSON.parse(SHALLOW_NON_PLACEHOLDER) as LocalExecutorAction
  )
  assert.ok(
    genericShooterGaps.includes('implemented firing') &&
      genericShooterGaps.includes('game-over state'),
    'a short shooter request still receives the default playability baseline'
  )

  const dirs: string[] = []
  try {
    const turkishDir = await mkdtemp(join(tmpdir(), 'akorith-local-workspace-turkish-'))
    dirs.push(turkishDir)
    const turkishAttempt = await executeLocalExecutorAttempt({
      workspaceDir: turkishDir,
      goal:
        'Tamamen oynanabilir bir Call of Duty web oyunu yap; başlat, yeniden başlat, WASD, fare ve dokunmatik ateş, düşman, skor, sağlık, cephane, doldurma, oyun bitti ve mobil düzen olsun.',
      rawOutput: SHALLOW_NON_PLACEHOLDER,
      completionMode: 'complete_request'
    })
    assert.equal(
      turkishAttempt.score.shouldCommit,
      false,
      'a Turkish game request cannot bypass the gameplay quality gate'
    )
    assert.match(
      turkishAttempt.score.reasons.join(' '),
      /missing implemented gameplay features/
    )

    const correctiveDir = await mkdtemp(join(tmpdir(), 'akorith-local-workspace-corrective-'))
    dirs.push(correctiveDir)
    const correctiveAttempt = await executeLocalExecutorAttempt({
      workspaceDir: correctiveDir,
      goal:
        'The current implementation failed browser acceptance. Fix it completely and replace the files with a finished offline COD-inspired top-down Canvas shooter. Add real Start and Restart, WASD, mouse/touch fire, health, ammo/reload, score, enemies, Game Over, and responsive behavior.',
      rawOutput: SHALLOW_NON_PLACEHOLDER,
      completionMode: 'complete_request'
    })
    assert.equal(
      correctiveAttempt.score.shouldCommit,
      false,
      'a corrective shooter request cannot bypass the gate by omitting the word build'
    )

    const incrementalDir = await mkdtemp(join(tmpdir(), 'akorith-local-workspace-incremental-'))
    dirs.push(incrementalDir)
    const incrementalAttempt = await executeLocalExecutorAttempt({
      workspaceDir: incrementalDir,
      goal: 'Add the first playable shooter foundation as one bounded loop cycle.',
      rawOutput: SHALLOW_NON_PLACEHOLDER
    })
    assert.equal(
      incrementalAttempt.score.shouldCommit,
      true,
      'durable incremental loops are not forced to complete an entire game in one cycle'
    )

    const retryDir = await mkdtemp(join(tmpdir(), 'akorith-local-workspace-retry-'))
    dirs.push(retryDir)
    let restoredBeforeRetry = false
    const provider = new FakeLocalProvider([STUB, COMPLETE], (call) => {
      if (call === 2) {
        restoredBeforeRetry =
          !existsSync(join(retryDir, 'index.html')) &&
          !existsSync(join(retryDir, 'styles.css')) &&
          !existsSync(join(retryDir, 'game.js'))
      }
    })
    const activities: ProviderActivity[] = []
    let streamed = ''
    const result = await sendWorkspaceLocal(
      provider,
      GOAL,
      'fixture',
      retryDir,
      new AbortController().signal,
      (activity) => activities.push(activity),
      (token) => {
        streamed += token
      }
    )

    assert.equal(provider.prompts.length, 2, 'one bounded corrective attempt is used')
    assert.equal(restoredBeforeRetry, true, 'the rejected draft is rolled back before retry')
    assert.match(provider.prompts[0], /Complete the entire user request in this response/)
    assert.match(provider.prompts[0], /Do not return a scaffold/)
    assert.match(provider.prompts[1], /Attempt 1 was rejected and fully reverted/)
    assert.match(provider.prompts[1], /placeholder implementation text|only \d+ characters/)
    assert.equal(provider.options[0].generation?.maxTokens, 8_192)
    assert.equal(provider.options[1].generation?.maxTokens, 8_192)
    assert.equal(result.usage.promptTokens, 30)
    assert.equal(result.usage.completionTokens, 15)
    assert.equal(result.usage.totalTokens, 45)
    assert.equal((result.raw as { acceptedAttempt: number }).acceptedAttempt, 2)
    assert.match(streamed, /2\/2 checks passed|1\/1 checks passed/)
    assert.ok(
      activities.some((activity) =>
        activity.kind === 'warning' &&
        activity.label.includes('reverted')
      ),
      'the corrective pass is visible in activity history'
    )
    assert.ok(
      activities.some((activity) =>
        activity.id === 'local-workspace:draft:1' &&
        activity.status === 'running' &&
        activity.detail?.includes('characters into the candidate patch')
      ),
      'streamed local output refreshes the visible draft activity instead of appearing stuck'
    )
    assert.ok(readFileSync(join(retryDir, 'game.js'), 'utf8').length >= 1_500)
    const cssOnlyFollowUp = JSON.parse(
      action(
        [
          {
            path: 'styles.css',
            content: 'body{min-height:100vh}@media(max-width:640px){canvas{width:100%}}'
          }
        ],
        'Refine the responsive presentation'
      )
    ) as LocalExecutorAction
    assert.deepEqual(
      requestedGameFeatureGaps(GOAL, cssOnlyFollowUp, retryDir),
      [],
      'follow-up patches are checked against the final workspace, not only the changed file'
    )

    const lengthRetryDir = await mkdtemp(join(tmpdir(), 'akorith-local-workspace-length-'))
    dirs.push(lengthRetryDir)
    let unchangedBeforeLengthRetry = false
    const lengthRetryProvider = new FakeLocalProvider(
      [STUB.slice(0, 200), COMPLETE],
      (call) => {
        if (call === 2) {
          unchangedBeforeLengthRetry =
            !existsSync(join(lengthRetryDir, 'index.html')) &&
            !existsSync(join(lengthRetryDir, 'styles.css')) &&
            !existsSync(join(lengthRetryDir, 'game.js'))
        }
      },
      ['length', 'stop']
    )
    const lengthRetryResult = await sendWorkspaceLocal(
      lengthRetryProvider,
      GOAL,
      'fixture',
      lengthRetryDir,
      new AbortController().signal,
      () => {},
      () => {}
    )
    assert.equal(
      unchangedBeforeLengthRetry,
      true,
      'a length-truncated draft is never parsed or applied before the compact retry'
    )
    assert.match(
      lengthRetryProvider.prompts[1],
      /compact complete implementation.*self-contained HTML/is,
      'the bounded retry explicitly asks for a compact complete artifact'
    )
    assert.equal(
      (lengthRetryResult.raw as { acceptedAttempt: number }).acceptedAttempt,
      2,
      'a verified compact retry is accepted after output truncation'
    )

    const doubleLengthDir = await mkdtemp(join(tmpdir(), 'akorith-local-workspace-double-length-'))
    dirs.push(doubleLengthDir)
    const doubleLengthProvider = new FakeLocalProvider(
      [STUB.slice(0, 200), STUB.slice(0, 220)],
      undefined,
      ['length', 'length']
    )
    await assert.rejects(
      sendWorkspaceLocal(
        doubleLengthProvider,
        GOAL,
        'fixture',
        doubleLengthDir,
        new AbortController().signal,
        () => {},
        () => {}
      ),
      /reached the output limit on both bounded attempts.*no partial JSON or unverified files were applied/i
    )
    assert.equal(
      existsSync(join(doubleLengthDir, 'index.html')),
      false,
      'two truncated drafts leave the workspace unchanged'
    )

    const failureDir = await mkdtemp(join(tmpdir(), 'akorith-local-workspace-failure-'))
    dirs.push(failureDir)
    const failedProvider = new FakeLocalProvider([STUB, STUB])
    await assert.rejects(
      sendWorkspaceLocal(
        failedProvider,
        GOAL,
        'fixture',
        failureDir,
        new AbortController().signal,
        () => {},
        () => {}
      ),
      /did not produce a verified workspace change after 2 attempts.*No failed draft was kept/
    )
    assert.equal(failedProvider.prompts.length, 2)
    assert.equal(existsSync(join(failureDir, 'index.html')), false)
    assert.equal(existsSync(join(failureDir, 'styles.css')), false)
    assert.equal(existsSync(join(failureDir, 'game.js')), false)

    console.log('verify-local-workspace: ok')
  } finally {
    await Promise.all(
      dirs
        .filter((dir) => existsSync(dir))
        .map((dir) => rm(dir, { recursive: true, force: true }))
    )
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
