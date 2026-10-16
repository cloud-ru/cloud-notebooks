<div align="center">

# Cloud.ru Distributed Train Notebooks

**Работайте с ноутбуками Cloud.ru Distributed Train прямо в VS Code и Cursor — без вкладки браузера.**

Войдите в Cloud.ru, выберите воркспейс, просматривайте свои ноутбуки и открывайте их веб-интерфейс,
запускайте ячейки на облачном ядре, ходите по файлам пода и открывайте полноценный Remote-SSH IDE —
всё из редактора.

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90-007ACC.svg?logo=visualstudiocode)](https://code.visualstudio.com/)
[![Cursor](https://img.shields.io/badge/Cursor-supported-4B0082.svg)](https://cursor.com)
[![Node](https://img.shields.io/badge/Node-%E2%89%A522-339933.svg?logo=nodedotjs)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10-F69220.svg?logo=pnpm)](https://pnpm.io/)

[English](README.md) · [Русский](README.ru.md)

</div>

---

## Возможности

- **Вход через Cloud.ru** — по SSO в браузере, без ключей и без регистрации OAuth-клиента; пока
  открыт VS Code, сессия продлевается в фоне.
- **Список ноутбуков** воркспейса с живым статусом; поиск по имени, фильтр по автору и статусу,
  избранное; редактирование описания одной командой.
- **Открытие веб-UI ноутбука внутри VS Code** — JupyterLab, marimo, VS Code-образ и другие.
- **Удалённое ядро (как в Colab)** — ячейки исполняются на облачном ядре через стандартное
  Jupyter-расширение.
- **Файлы пода по SSH/SFTP** — браузер файлов прямо в проводнике VS Code: копирование, переименование,
  удаление.
- **Полный IDE-режим** — открыть под как окно **Remote-SSH** (терминал, IntelliSense на удалёнке);
  сервер VS Code/Cursor предварительно заливается на под, чтобы медленный egress не тормозил вход.
- **Жизненный цикл из редактора** — запуск/пауза/удаление с отслеживанием прогресса; логи инлайн
  или скачиванием за последние сутки/3/7 дней.
- **Управление SSH-ключами** — генерация нового ключа в Cloud.ru или загрузка своего публичного.

---

## Как это работает

Войдите один раз с учётной записью Cloud.ru (SSO в браузере). Расширение показывает список
Jupyter Server и управляет ноутбуками, а к запущенным ноутбукам подключается по SSH — для
встроенного веб-интерфейса, удалённого ядра, файлов и Remote-SSH.

---

## Быстрый старт (разработка)

Требования: Node.js ≥ 22, pnpm 10 (`corepack enable`), VS Code ≥ 1.90 / Cursor, локальный
Chrome/Chromium/Edge для входа.

```bash
pnpm install
pnpm bundle:watch     # esbuild watch → dist/extension.js
# нажмите F5 → «Run Extension» (см. .vscode/launch.json)
```

Во втором окне (Extension Development Host): откройте вью **Cloud.ru Distributed Train** → **Sign in** →
**Select Workspace** → работайте со списком ноутбуков.

```bash
pnpm test         # юнит-тесты (vitest)
pnpm typecheck    # проверка типов (tsc --noEmit)
pnpm bundle       # разовая сборка
```

Полный гайд (требования, тесты, сборка `.vsix`, публикация, диагностика) —
в [docs/development.md](docs/development.md).

---

## Команды

Все доступны через палитру (`Cmd/Ctrl+Shift+P`, префикс «Cloud.ru:») и меню **«…»** на строке ноутбука
(действия описаны словами). Фильтры собраны в меню-воронку в шапке вью.

| Команда | Действие |
|---------|----------|
| Sign In / Sign Out | Вход/выход в Cloud.ru |
| Select Workspace | Выбрать воркспейс |
| Refresh Notebooks | Обновить список |
| Open Notebook in VS Code | Открыть веб-UI ноутбука в редакторе |
| Open Notebook in Browser | Открыть ноутбук во внешнем браузере |
| Start / Pause Notebook | Запустить / поставить на паузу |
| Show Logs | Логи ноутбука + причина статуса |
| Download Logs… | Скачать логи за последние сутки/3/7 дней |
| Edit Description… | Изменить описание ноутбука |
| Browse Notebook Files (SSH) | Открыть файлы пода по SFTP |
| Open Full IDE (Remote-SSH) | Открыть под как Remote-SSH окно |
| Configure SSH / Get SSH Key / Upload Public SSH Key | Управление SSH-ключом Distributed Train |
| Search / Filter by Author / Filter by Status / Favorites | Поиск, фильтр по автору и статусу, избранное |

---

## Настройки

Все настройки — только пользовательские: значения из `.vscode/settings.json` рабочей папки игнорируются.

| Ключ | По умолчанию | Назначение |
|------|--------------|------------|
| `cloudru.console.apiBaseUrl` | `https://console.cloud.ru/aicloud/ui` | База web-API консоли |
| `cloudru.console.url` | `https://console.cloud.ru/` | URL, открываемый для входа и захвата токена |
| `cloudru.notebook.chromePath` | `` (автоопределение) | Путь к Chrome/Chromium/Edge для входа |
| `cloudru.console.keepSessionAlive` | `true` | Продлевать сессию в фоне, чтобы она не истекала, пока открыт VS Code (пауза после 8 часов без активности) |
| `cloudru.ssh.privateKeyPath` | `` | SSH-ключ Distributed Train (для файлов, ядра, IDE) |
| `cloudru.ssh.host` | `ssh-jupyter.ai.cloud.ru` | Дефолтный хост SSH-шлюза (обычно берётся из вставленной SSH-команды) |
| `cloudru.ssh.port` | `2222` | Порт SSH-шлюза |

---

## Документация

| Документ | О чём |
|----------|-------|
| [docs/development.md](docs/development.md) | Запуск в дев-режиме, тесты, сборка, публикация |

---

## Участие в проекте

Баг-репорты и пулл-реквесты приветствуются — см. [CONTRIBUTING.md](CONTRIBUTING.md).
Вопросы безопасности: [SECURITY.md](SECURITY.md). История изменений — [CHANGELOG.md](CHANGELOG.md).

---

## Лицензия

[Apache-2.0](LICENSE)
