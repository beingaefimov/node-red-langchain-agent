# node-red-langchain-agent v.0.1

**Это ещё не готовое решение, а скорее "постановка задачи" в виде работающего образца**

ReAct-агент для Node-RED на базе LangChain. Вдохновлён нодой **Agent** из `@n8n/n8n-nodes-langchain`: цикл рассуждений, tool-calling, `maxIterations` / `returnIntermediateSteps` / `handleParsingErrors`, встроенный в потоковую модель Node-RED с поддержкой MCP, OAuth2 (PKCE), векторного хранилища и SSE-стриминга.

** Начиная с версии 1.0, в LangChain отказались от поддержки CommonJS (синхронного require()) и перешли на ESM-модули (асинхронный import). Здесь пока используем ветку 0.3.x LangChain - это последняя стабильная версия, в которой ещё осталась поддержка CommonJS. Для перехода на LangChain 1.2.1, переписать весь код нод на ESM:
Добавить "type": "module" в package.json нод.
Заменить во всех файлах const x = require(...) на import x from ....
Заменить module.exports = function(RED) { ... } на export default function(RED) { ... }.
Учесть, что ESM-импорты асинхронны, и переделать логику загрузки конфигураций**

## Возможности

| Возможность | Где |
|---|---|
| ReAct-агент (Thought -> Action -> Observation -> Final Answer) | `langchain-agent`, `langchain-agent-api` |
| Асинхронный HTTP-эндпоинт + SSE-стриминг | `langchain-agent-api` |
| Подключение к MCP-серверам (stdio + SSE) | `langchain-mcp-client` |
| OAuth2 с PKCE (S256) для OpenAI / Anthropic | `langchain-config` |
| Память диалога по `sessionId` | `langchain-memory-buffer` |
| RAG-инструмент (in-memory vector store) | `langchain-vectorstore` |
| Кастомные инструменты на JS | `langchain-tool-function` |
| Поддержка OpenAI-совместимых API (LM Studio, vLLM, llama.cpp, ollama-proxy и т.п.) | `langchain-config` -> Base URL |

## Состав пакета

| Нода | Тип | Категория в палитре | Назначение |
|---|---|---|---|
| `langchain-agent` | regular | `langchain` | Агент в потоке. Для коротких прогонов (<2 c) и случаев, когда нужен синхронный wire. |
| `langchain-agent-api` | **config** | `config` | Асинхронный HTTP-эндпоинт на заданном маршруте. JSON или SSE. |
| `langchain-config` | config | `config` | Провайдер + модель + ключ. Поддержка **API key** или **OAuth2**. |
| `langchain-chat-model` | sub-node | `langchain` | Обёртка над OpenAI/Anthropic chat-моделью. |
| `langchain-tool-function` | sub-node | `langchain` | Кастомный инструмент, тело функции пишется в UI. |
| `langchain-memory-buffer` | sub-node | `langchain` | Скользящее окно истории диалога. |
| `langchain-vectorstore` | sub-node | `langchain` | RAG-инструмент с подключаемым хранилищем. |
| `langchain-mcp-client` | sub-node | `langchain` | MCP-клиент (stdio + SSE). |

`langchain-agent-api`, это config-нода без входов/выходов, которая регистрирует HTTP-маршрут. Несколько `langchain-agent` в потоках могут привязываться к одной и той же agent-api через типизированное поле `agentApi`, то же самое, что «один эндпоинт, много триггеров» в n8n.

## Установка

```bash
cd ~/.node-red
mkdir node-red-langchain-agent
cd node-red-langchain-agent
npm install
```

Перезапустить Node-RED. В палитре появится категория **langchain**.

## Быстрый старт

### 1. Создать config-ноду

В Node-RED -> **Config nodes** -> **+ add** -> **LangChain config**:

- **Provider:** `OpenAI (or OpenAI-compatible)`
- **Model:** имя модели (например `gpt-4o-mini`, `llama-3.1-70b`, `qwen-2.5-72b`)
- **Base URL:** адрес OpenAI-совместимого API (например `http://192.168.1.137:3101/v1`)
- **Auth:** `API key`
- **API key:** значение, которое требует провайдер (для локальных без авторизации, любое)

-> **Done**, **Deploy**.

### 2. Создать chat-model в потоке

Перетащить **chat model** в поток, в свойствах выбрать созданный config.

### 3. Создать agent-api

Перетащить **agent (API)** в поток (это config-нода):

- **Route:** `/agent/run`
- **Chat model:** выбрать ноду из шага 2
- **Tool sub-nodes (ids):** оставить пустым
- **System message:** `You are a helpful assistant.`

-> **Done**, **Deploy**.

### 4. Проверить

```bash
curl -X POST http://localhost:1880/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"input":"Привет, кто ты?"}'
```

В ответе JSON с полем `output`.

## Два способа вызвать агента

### Способ A: HTTP-роут от `langchain-agent-api` (лучше)

Агент работает асинхронно, поток Node-RED не блокируется. Подходит для длинных ReAct-цепочек и стриминга.

```bash
# JSON-ответ
curl -X POST http://localhost:1880/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"input":"Какая погода в Москве?","sessionId":"user-42"}'

# SSE-стрим (токены приходят в реальном времени)
curl -N -X POST http://localhost:1880/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"input":"Расскажи длинную историю","stream":true}'
```

#### События SSE

| Событие | Когда | Поле `data` |
|---|---|---|
| `start` | первый байт ответа | `{requestId, input, ts}` |
| `step` | каждая итерация ReAct | `{n, label}` |
| `token` | дельта от LLM | `{delta}` |
| `tool_call` | начало вызова инструмента | `{step, tool, input}` |
| `tool_result` | конец вызова инструмента | `{step, tool, output}` |
| `final` | агент завершил работу | `{requestId, output, steps, durationMs}` |
| `error` | терминальная ошибка | `{requestId, message, stack}` |

Стриминг реализован через `executor.streamEvents({version: 'v1'})`, единый источник истины и для токенов, и для границ вызовов инструментов. Двойного вызова LLM нет.

### Способ B: нода `langchain-agent` внутри потока

Для коротких задач (до 2–3 секунд), когда нужно связать агента с другой логикой Node-RED.

```
[inject] -> [chat-model] -> [agent] -> [debug]
```

`inject` отправляет `msg.payload = "вопрос"` или `msg.payload = {input: "вопрос"}`.

## Подключение инструментов

### Кастомный инструмент (function-tool)

Перетащить **Function tool**, заполнить:

- **Tool name:** `get_weather`
- **Description for the LLM:** `Получить текущую погоду в городе. Аргумент — название города.`
- **Function body:**
  ```js
  // input: string от LLM, вернуть string
  return `Погода в ${input}: +15°C, ясно`;
  ```

Привязать к `langchain-agent-api` через поле **Tool sub-nodes (ids)**, id ноды инструмента (видно в URL редактора при двойном клике по ноде).

### MCP-инструменты

Перетащить **MCP client tool**.

**stdio-вариант** (MCP-сервер запускается как процесс):

- **Transport:** `stdio`
- **Command:** `npx`
- **Args** (по строке на аргумент):
  ```
  -y
  @modelcontextprotocol/server-filesystem
  /tmp
  ```
- **Env** (опционально, по строке `KEY=VALUE`):
  ```
  API_KEY=xxx
  DEBUG=1
  ```

**SSE-вариант** (удалённый MCP):

- **Transport:** `SSE`
- **SSE URL:** `https://mcp.example.com/sse`
- **Tool name allowlist:** `search,fetch` (через запятую; опционально)

Все MCP-инструменты попадают к агенту с префиксом `mcp_<имя>` (например, `search` -> `mcp_search`).

## Память диалога

Перетащить **memory buffer**. Каждый `msg.sessionId` (или `msg.payload.sessionId`) получает свою историю.

```
[inject] -> [chat-model] -> [memory] -> [agent] -> [debug]
```

В `inject` задавать стабильный `sessionId`:
```js
msg.sessionId = "user-42";
msg.payload = "Привет!";
```

Следующее сообщение с тем же `sessionId` будет учитывать контекст.

## RAG (поиск по базе знаний)

Перетащить **vector store**:

- **Collection:** `kb-main`
- **Chunk size:** `1000`
- **Top-K:** `4`
- **Embedding model:** выбрать `chat-model` ноду

Загрузка документов:
```
POST http://localhost:1880/vectorstore/add
Content-Type: application/json

{ "collection": "kb-main", "document": "Длинный текст..." }
```

Или через поток: `msg.payload = {action: "add", document: "..."}`.

После этого подключить `vector store` к `langchain-agent-api` в поле **Tool sub-nodes (ids)**. Агент получит инструмент `kb-main_search` и будет сам вызывать его при необходимости.

## OAuth2 (вместо API-ключа)

1. Создать OAuth2-клиента в консоли провайдера. Redirect URI: `<editor-url>/langchain-agent/oauth/<config-node-id>/callback`
2. В `langchain-config` -> **Auth:** `OAuth2`, выбрать провайдера, вставить client id + secret.
3. Нажать **Authorize via OAuth2**, подтвердить в попапе.
4. Токены хранятся на config-ноде и автоматически обновляются по refresh.

Из коробки поддержаны:

- `openai-oauth` (OpenAI Platform OAuth2)
- `anthropic-oauth` (Anthropic Console OAuth2)

### PKCE (RFC 7636)

- Всегда используется `code_challenge_method=S256` (безопасный дефолт).
- `code_verifier` - 32 случайных байта, base64url.
- Генерируется в `/start`, сохраняется в `pendingStates` (TTL 10 минут, GC каждую минуту), потребляется в `/callback` на запросе token-exchange. Одноразовый.
- Дополнительные провайдеры добавляются в `OAUTH2_PROVIDERS` файла `src/config.js`, нужны только `authorizationUrl` и `tokenUrl`.

## Известные проблемы

1. **При каждом deploy происходит перерегистрация HTTP-маршрутов.** Если в потоке две `langchain-agent-api` с одинаковым `route`, вторая выдаст warning и не зарегистрируется. Это by design, не дублировать маршрут.
2. **MCP-соединения в текущей реализации не закрываются автоматически** после завершения запроса. При интенсивном использовании stdio-серверов процессы могут накапливаться. До доработки: перезапускать Node-RED раз в N запросов, либо мониторить процессы. В `agent-api.js` после `executor.invoke()` и после `streamExecutor` нужно добавить закрытие `msg.langchain.mcpClient`.
3. **Длинные ReAct-цепочки блокируют HTTP-сокет Node-RED**, если используется нода `langchain-agent` обычная. Для длинных работ использовать `langchain-agent-api`, он уходит в `setImmediate` и не блокирует event loop.
4. **Для OpenAI-совместимых серверов** (LM Studio, vLLM, llama.cpp, ollama через прокси) **Base URL обязателен.** Поле API key допустимо оставить пустым или заполнить любым значением, если сервер не проверяет авторизацию.
5. **Дефолт `returnIntermediateSteps`** рассинхронизирован между кодом (`true`) и UI (`false`), если нужны промежуточные шаги в JSON-ответе, явно включить чекбокс.

## Известные направления доработки

### Высокий приоритет

- Закрытие MCP-клиента после завершения запроса (см. пункт 2 выше).
- Fallback на переменные окружения (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`), если поле API key в config-ноде пустое.
- Отдельная нода `langchain-embeddings`, сейчас vector store использует chat-модель для эмбеддингов, что работает, но неоптимально.

### Средний приоритет

- Единый путь для `invoke` и `streamEvents`: собирать стрим в JSON-ответ через `collect()` или `for await + final`.
- Согласовать дефолт `returnIntermediateSteps` в коде и UI.
- Документация к каждому `examples/*.json`, почему такая структура, какие edge cases покрыты.

### Низкий приоритет

- Тесты: README упоминает `test/agent.spec.js`, но самого файла в репозитории нет.
- TS-типы для IDE-подсказок.
- Расширить набор MCP-серверов в `OAUTH2_PROVIDERS`.

## ReAct-промпт

Шаблон по умолчанию (переопределяется через поле **system message** ноды agent-api):

```
Answer the following questions as best you can. You have access to the following tools:

{tools}

Use the following format:

Question: the input question you must answer
Thought: you should always think about what to do
Action: the action to take, should be one of [{tool_names}]
Action Input: the input to the action
Observation: the result of the action
... (this Thought/Action/Action Input/Observation can repeat N times)
Thought: I now know the final answer
Final Answer: the final answer to the original input question

Begin!

Question: {input}
Thought:{agent_scratchpad}
```

## Зачем разделение на `langchain-agent` и `langchain-agent-api`

Node-RED исполняет обработчики нод на основном event loop. Вызов `AgentExecutor` на 30 секунд заблокировал бы весь потоковый движок. `langchain-agent-api` отдаёт работу в `setImmediate` и отвечает по HTTP, поток остаётся отзывчивым. **Для любого production-сценария использовать `langchain-agent-api`.**

## Минимальный HTTP-пример

```bash
curl -X POST http://localhost:1880/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"input":"what is 5 + 3 ?","sessionId":"demo"}'
```

Ответ:
```json
{
  "requestId": "...",
  "input": "what is 5 + 3 ?",
  "output": "8",
  "intermediateSteps": [...],
  "durationMs": 1240
}
```

SSE-вариант:
```bash
curl -N -X POST http://localhost:1880/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"input":"what is 5 + 3 ?","stream":true}'
```

## Сравнение с n8n

| Возможность | n8n | Этот пакет |
|---|---|---|
| ReAct-агент | ✅ | ✅ |
| Tool sub-node | ✅ (типизированные порты) | ⚠️ (через `msg.langchain.tools`) |
| Memory sub-node | ✅ | ✅ |
| LLM sub-node | ✅ (типизированный порт) | ⚠️ (через `msg.langchain.llm`) |
| Vector store | ✅ (Chroma, Pinecone, Qdrant, …) | ⚠️ (in-memory) |
| MCP client | ✅ | ✅ (stdio + SSE) |
| OAuth2 | ⚠️ (ограниченно) | ✅ (PKCE S256) |
| SSE-стриминг | ✅ | ✅ |
| HTTP-эндпоинт как config | ✅ | ✅ |
| Не блокирует event loop | ✅ | ✅ (`setImmediate` в agent-api) |

Node-RED не имеет типизированных AI-портов, поэтому в пакете реализован контракт через `msg.langchain.{llm,tools,memory}` - практически полный аналог типизированных подключений n8n.

## Примеры потоков

Готовые к импорту потоки лежат в папке `examples/`. Все примеры заточены под OpenAI-совместимый эндпоинт (например `http://192.168.1.137:3101/v1`), для переключения достаточно изменить поле **Base URL** в `langchain-config`.

| Файл | Что демонстрирует |
|---|---|
| `01-quickstart.json` | Минимальный сценарий: curl -> ответ. |
| `02-llm-with-tools.json` | Агент с двумя function-инструментами (калькулятор, время). |
| `03-streaming-sse.json` | SSE-стриминг + HTML-страница для браузера с показом токенов. |
| `04-memory-chat.json` | Многоходовой диалог с памятью по `sessionId`. |
| `05-rag.json` | RAG с векторным хранилищем, автозагрузка примеров при deploy. |
| `06-mcp-stdio.json` | Подключение к MCP filesystem-серверу через stdio. |
| `calculator.json` | Пример запуска агента с локальной LLM и кастомным инструментом. |
| `long-running.json` | Асинхронный HTTP агент с MCP инструментами. |

Импорт: меню Node-RED -> **Import -> Clipboard** -> вставить JSON.

Работа примера `long-running.json` требуетт запуска
```bash
npx -y @modelcontextprotocol/server-everything sse
```

Пример запуска:

```bash
# пример 01 - минимальный
curl -X POST http://localhost:1880/agent/run \
  -H 'Content-Type: application/json' \
  -d '{"input":"17 * 23"}'

# пример 03 - стриминг (открыть http://localhost:1880/chat в браузере)

# пример 04 - диалог с памятью
curl -X POST http://localhost:1880/mem/chat \
  -H 'Content-Type: application/json' \
  -d '{"input":"Привет! Меня зовут Алексей.","sessionId":"u1"}'
curl -X POST http://localhost:1880/mem/chat \
  -H 'Content-Type: application/json' \
  -d '{"input":"Как меня зовут?","sessionId":"u1"}'
```
