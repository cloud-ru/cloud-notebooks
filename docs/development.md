# Запуск в дев-режиме и сборка

Как расширение проходит путь от исходников → запуска в VS Code → сборки `.vsix` → публикации.

- [Требования](#требования)
- [Установка и сборка](#установка-и-сборка)
- [Запуск в дев-режиме (F5)](#запуск-в-дев-режиме-f5)
- [Тесты и проверки](#тесты-и-проверки)
- [Сборка .vsix](#сборка-vsix)
- [Публикация](#публикация)
- [Как проверять встраивание ноутбука](#как-проверять-встраивание-ноутбука)
- [Отладка и диагностика](#отладка-и-диагностика)

---

## Требования

- **Node.js ≥ 22** для разработки. В рантайме используется `Promise.withResolvers`; VS Code 1.101
  [перешёл на Node.js 22](https://code.visualstudio.com/updates/v1_101). Версию Node внутри Cursor
  нужно проверить отдельно перед установкой.
- **pnpm** — пакетный менеджер проекта (версия закреплена в `package.json` → `packageManager`). Проще
  всего через Corepack: `corepack enable` (идёт с Node), либо `npm i -g pnpm` / `brew install pnpm`.
- **VS Code ≥ 1.101** (или форк с совместимым extension host на Node.js 22).
- **Системный Chrome / Chromium / Edge** — нужен для одноразового входа в Cloud.ru (расширение не
  тащит свой браузер). Автоопределяется; путь можно задать в настройке `cloudru.notebook.chromePath`.
- Для работы с ноутбуками: учётная запись Cloud.ru с доступом к Distributed Train-воркспейсу. **Ключи и
  регистрация OAuth-клиента не нужны** — вход идёт по SSO в браузере.

> pnpm 10 по умолчанию блокирует install-скрипты зависимостей. Postinstall у `esbuild` разрешён через
> `pnpm.onlyBuiltDependencies` в `package.json`, поэтому свежий `pnpm install` корректно линкует
> бинарь esbuild. Добавляете зависимость с install-скриптом — допишите её туда же.

---

## Установка и сборка

```bash
pnpm install
pnpm bundle           # разовая сборка esbuild → dist/extension.js
pnpm bundle:watch     # пересборка при изменениях (для разработки)
pnpm typecheck        # tsc --noEmit (esbuild сам типы не проверяет)
```

- `dist/extension.js` — бандл-точка входа, объявленная в `package.json#main`. Файл в `.gitignore` и
  пересобирается по требованию (а также автоматически перед упаковкой через `vscode:prepublish`).
- В бандл **не** включаются `puppeteer-core` и `ssh2` (тяжёлые / с нативными частями) — они помечены
  `external` в `esbuild.js` и приезжают из `node_modules` в рантайме. `http-proxy` бандлится внутрь.

---

## Запуск в дев-режиме (F5)

Это основной цикл разработки — упаковка не нужна.

1. Откройте папку проекта в VS Code / Cursor.
2. Запустите `pnpm bundle:watch` (или положитесь на `preLaunchTask`).
3. Нажмите **F5** (конфигурация «Run Extension» в `.vscode/launch.json`). Откроется второе окно —
   **Extension Development Host** — с загруженным расширением.
4. В этом окне:
   - откройте вью **Cloud.ru Distributed Train** на панели активности;
   - **Sign in to Cloud.ru** → откроется браузер → войдите по SSO → окно закроется, токен захвачен;
   - **Select Workspace** → выберите воркспейс из списка → подгрузится список ноутбуков;
   - клик по запущенному ноутбуку открывает его в VS Code; меню **«…»** (три точки) на строке —
     словесные действия: открыть в VS Code/браузере, изменить описание, логи (просмотр и скачивание),
     файлы по SSH, полный IDE, пауза/запуск/удаление, избранное.
5. Логи — в **Output → «Cloud.ru Distributed Train»** (секреты вырезаются).
6. После правок кода: watcher пересобирает бандл → нажмите **Ctrl/Cmd+R** в окне дев-хоста (или
   *Developer: Reload Window*).

---

## Тесты и проверки

```bash
pnpm test         # юнит-тесты (vitest), без VS Code
pnpm typecheck    # проверка типов
```

Юнит-тесты покрывают чистую логику без зависимости от `vscode`: маппинг DTO и нормализацию статусов,
разбор URL ноутбука и ядра, построение тела resume (в т.ч. подстановку labels harbor-образа), разбор
Content-Disposition для логов, цикл поллинга статуса (`pollLoop`), таймаут HTTP-клиента, преобразование
заголовков shim'а, разбор/сборку SSH-config и URI, статусную модель, список действий ноутбука, контракты
клиента API (`ConsoleApiClient` через инъектируемый `fetchImpl`) и маппинг ошибок API. Тесты идут за
миллисекунды и не ходят в сеть.

Живой путь (вход в браузере, туннель, webview, исполнение ячеек, диалоги выбора SSH-ключа)
детерминированно не тестируется — его проверяют вручную в дев-хосте по чек-листу ниже.

### Ручной smoke-чек-лист (Extension Development Host)

Прогнать перед релизом; результаты приложить к PR.

1. Чистый профиль → **Войти** → выбор воркспейса → загрузился список ноутбуков.
2. Протухшая сессия (удалить папку `console-profile` в globalStorage) → любая команда → ровно один тост
   «Сессия Cloud.ru истекла» с кнопкой «Войти», без сырых ошибок и без InputBox с id воркспейса.
3. pause → resume → открыть ноутбук («Открыть в VS Code») и выбрать облачное ядро без перезапуска VS Code.
4. resume заведомо сломанного ноутбука → тост «Не удалось запустить …» с кнопкой «Показать логи».
5. Отмена: прогресса входа (окно браузера закрывается), поллинга (pause/resume), SSH-подключения.
6. Обрыв сети (выключить Wi-Fi) → команды завершаются за ~30 с с кнопкой «Повторить».
7. Чистый профиль → «Файлы по SSH» → QuickPick «Сгенерировать новый ключ …» проходит без выбора файла.

---

## Сборка .vsix

```bash
pnpm install --frozen-lockfile --config.node-linker=hoisted
pnpm dlx @vscode/vsce package   # → cloudru-jupyter-vscode-<версия>.vsix
```

- `vsce` сначала прогоняет `vscode:prepublish` (продакшен-бандл).
- **`--config.node-linker=hoisted` обязателен.** `vsce` обходит продакшен-зависимости через
  `npm list`, а обычный (isolated) `node_modules` от pnpm 10 он прочитать не может и падает с
  `npm error missing: …`. Плоский (hoisted) `node_modules` устраняет проблему. Именно так это
  делает GitHub Actions (`.github/workflows/ci.yml`).
- **Не** передавайте `--no-dependencies`: `puppeteer-core` и `ssh2` — реальные рантайм-зависимости,
  помеченные `external`, и должны уехать в `node_modules`. `vsce` включает `dependencies` (не
  `devDependencies`) автоматически.
- Что попадает в `.vsix`, ограничено `.vscodeignore` (только `dist/`, `package.json`, README,
  `media/` и продакшен-`node_modules`; исходники/тесты/доки исключены).

Установить локально:

```bash
code --install-extension cloudru-jupyter-vscode-<версия>.vsix
```

или в VS Code: вью Extensions → меню «…» → **Install from VSIX…**.

---

## Публикация

Workflow `.github/workflows/release.yml` после каждого обновления `main` проверяет типы и тесты,
собирает `.vsix` и создаёт GitHub Release с тегом `main-<номер запуска>`. Внутри `.vsix` версия
`major.minor.<номер запуска>`: `major.minor` берутся из `package.json`. Новый выпуск помечается как
Latest; файл можно скачать со страницы Releases. Тот же `.vsix` публикуется в GitHub Packages как
OCI-артефакт `ghcr.io/cloud-ru/cloud-notebooks-vsix` с тегами `main-<номер запуска>` и `main`.
Раздел Packages не хранит `.vsix` как самостоятельный тип пакета: для скачивания оттуда нужен ORAS.
Ручной push тега `v<версия из package.json>` по-прежнему создаёт отдельный выпуск и версию пакета.
Для работы workflow не нужен PAT: он использует `GITHUB_TOKEN`.

После мержа проверьте в GitHub: **Actions → Release** (успешный запуск), **Releases → Latest**
(файл `.vsix`) и **Packages → cloud-notebooks-vsix** (тег `main`). Репозиторий приватный; пакет
по умолчанию также приватный. Владельцу репозитория нужно разрешить GitHub Actions и убедиться, что
политика организации допускает права `contents: write` и `packages: write`, запрошенные в workflow.
Если пакет с таким именем уже создан отдельно от репозитория, в его настройках надо дать этому
репозиторию доступ на запись для Actions. Дополнительные secrets не нужны.

Скачать актуальный `.vsix` из Packages при наличии доступа можно так:

```bash
oras login ghcr.io  # учётные данные GitHub с правом read:packages
oras pull ghcr.io/cloud-ru/cloud-notebooks-vsix:main
```

Публикация в каталоги расширений настраивается отдельно:

- **VS Code Marketplace** (Azure DevOps): создать publisher (поле `publisher` в `package.json` должно
  совпадать), завести PAT со scope **Marketplace → Manage**, затем
  `pnpm dlx @vscode/vsce publish`. Версию нужно поднимать на каждый релиз.
- **Open VSX** (для VSCodium / Cursor и других форков): `pnpm dlx ovsx publish <файл>.vsix -p <token>`.

Оба GitHub Actions workflow перед упаковкой прогоняют `typecheck` и `test`. Для локальной упаковки
используйте закреплённую в `.github/workflows/release.yml` версию `@vscode/vsce`.

---

## Как проверять встраивание ноутбука

Для этого нужен SSH-ключ Distributed Train (скачивается из консоли) — задайте его в
`cloudru.ssh.privateKeyPath` или через команду **Configure SSH**.

1. `pnpm bundle` → F5. Войдите, выберите воркспейс, кликните **running**-ноутбук → «Open in VS Code».
2. Откроется webview с веб-интерфейсом (JupyterLab / marimo / др.).
3. В Output → «Cloud.ru Distributed Train» проверьте строки `Notebook app path resolved to …` и `shim 200 GET …`.
4. Для удалённого ядра: откройте `.ipynb`, выберите облачный сервер в пикере ядра Jupyter, запустите
   ячейку — вывод приходит по туннелю.

---

## Отладка и диагностика

- **Output → «Cloud.ru Distributed Train»** — основной канал логов. Bearer-токены и чувствительные заголовки
  вырезаются.
- `fetch failed` / сетевые ошибки API теперь показывают первопричину (например, код TLS-ошибки) — если
  это CA, проверьте, что машина за корпоративным прокси (расширение уже доверяет системному
  хранилищу CA; на изолированных сетях этого может не хватать).
- Если вход не находит браузер — задайте путь в `cloudru.notebook.chromePath`.
- SSH-эндпоинт собирается автоматически из данных консоли, копировать команду из консоли не нужно.
  Если автоподключение не удалось,
  «Browse Files (SSH)» предложит ввести команду из консоли (ручной override на регион). **Configure
  SSH** — перевыбор ключа и сброс кеша эндпоинтов; дефолтный хост/порт — в `cloudru.ssh.host` / `cloudru.ssh.port`.
