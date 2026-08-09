---
name: living-architecture
description: >
  Scan a codebase and generate a living ARCHITECTURE.md file containing pure Mermaid diagrams — no prose,
  no text explanations, only diagrams. Covers system overview, component relationships, data flow,
  database schemas, key sequences, and class structures — automatically choosing depth and diagram types
  based on what the codebase actually contains. Use this skill whenever the user asks to visualize,
  document, diagram, or map out their system architecture, or when they say things like "show me how
  this system works", "generate architecture docs", "create a system diagram", "map out the codebase",
  "I need a bird's eye view", or "draw the architecture". Also activate when code changes are made and
  the user asks to update or refresh the architecture, or when reviewing a PR and wanting to see
  structural impact. Even if the user just says "update the arch" or "refresh diagrams" — this is the
  skill for that.
---

# Living Architecture

Generate and maintain a living `ARCHITECTURE.md` composed entirely of Mermaid diagrams.
No text explanations. No prose sections. Only diagrams, each preceded by a single HTML comment
identifying what it represents (for anchor navigation and machine parsing).

---

## Core Philosophy

Architecture diagrams rot the moment they're written. This skill fights that by treating
`ARCHITECTURE.md` as a **derived artifact** — something generated from the code, not maintained
alongside it. Every time you touch the codebase, the diagrams should reflect reality.

The file is pure Mermaid. A developer should be able to open it in any Markdown renderer
(GitHub, VS Code, Obsidian, etc.) and immediately see the full system without reading a
single paragraph of explanation. The diagrams *are* the explanation.

But this skill goes further than documentation. The act of diagramming a system forces you
to confront its real structure — and a well-drawn diagram makes architectural quality (or debt)
immediately visible. A clean system produces clean diagrams. A tangled system produces tangled
diagrams. The diagrams are a mirror: if you don't like what you see, the code needs work.

---

## Architectural Thinking

Before drawing a single node, understand **what good architecture looks like**. These principles
guide both how you scan the codebase and how you represent it in diagrams. When the code
follows these patterns, the diagrams will be clean and readable. When it doesn't, the diagrams
will reveal the mess — and that's intentional.

### The Principles That Shape Great Systems

**1. Unidirectional Dependency Flow**

Dependencies should flow in one direction: from the outside in, from the specific to the
abstract. Presentation depends on Logic. Logic depends on Data Access. Data Access depends on
the Database. Never the reverse.

When scanning, trace the import/require graph. If a database utility imports from a UI
component, or a service layer reaches into a controller, that's a structural violation.
In the diagram, this appears as an arrow going "upward" — against the natural flow. Make it
visible by using a dashed red edge style:

```
A -.->|coupling violation| B
linkStyle 0 stroke:#e74c3c,stroke-width:2
```

**2. Clear Boundaries Between Domains**

Each major feature area or domain should be a self-contained unit. Services within a domain
can talk freely, but cross-domain communication should happen through well-defined interfaces.

In diagrams, domains become `subgraph` blocks. A well-bounded system has few edges crossing
subgraph boundaries. If your overview diagram has arrows criss-crossing everywhere between
subgraphs, the domain boundaries are leaking.

**3. The Dependency Rule (Clean Architecture)**

Inner layers know nothing about outer layers:
- **Entities / Domain models** — know nothing, depend on nothing
- **Use cases / Services** — know about entities, nothing else
- **Interface adapters (Controllers, Gateways)** — know about use cases
- **Frameworks & Drivers (DB, Web, UI)** — know about adapters

When a codebase follows this, its component diagram naturally forms concentric layers with
arrows pointing inward. When it doesn't, you get spaghetti.

**4. Single Responsibility at Every Scale**

A module should do one thing. A service should own one domain. A layer should handle one
concern. This applies fractally — from individual files up to entire microservices.

When scanning, notice modules that appear in too many diagrams, or nodes with too many
edges. A service that connects to everything is a god service. A component that every other
component depends on is a hidden monolith. Surface these in diagrams by the sheer density
of their connections — don't hide them.

**5. Explicit Over Implicit**

Good architectures make their structure obvious from the file system. You should be able to
guess the architecture from `ls -R`. When you can't — when you need to read deep into files
to understand what connects to what — that's a smell.

During scanning, notice how much you have to dig. If the directory structure tells the whole
story, the architecture is explicit. If you had to trace through 5 files to find a hidden
dependency, note it.

### Recognizing Architectural Patterns

See `references/architectures.md` for a guide on recognizing and diagramming common patterns (Layered, Hexagonal, Event-Driven, Microservices, etc.).

### Spotting Architectural Smells (Through Diagrams)

The power of this skill is that architectural problems become **visually obvious** in well-drawn
diagrams. You don't need text callouts — the shape of the diagram tells the story.

**Circular Dependencies**
If A depends on B and B depends on A, the diagram shows bidirectional arrows or cycles.
This should jump out. Use dashed edges with a distinct style to mark these:
```
A -->|uses| B
B -.->|circular dep| A
linkStyle 1 stroke:#e74c3c,stroke-dasharray:5
```

**God Module**
A node with 8+ edges (incoming or outgoing) dominates the diagram. It's visually obvious —
one node in the center with tentacles reaching everywhere. Don't downplay this by hiding
connections. Show them all. The ugliness is the message.

**Missing Abstraction Layer**
When the presentation layer directly queries the database (skipping business logic), the
diagram shows arrows jumping across layers. In a `graph TD`, you'll see long vertical
arrows bypassing the middle layer entirely.

**Distributed Monolith**
Multiple "services" that all share the same database and call each other synchronously in
chains. The microservices diagram looks like a monolith with extra network hops. Many
inter-service arrows, single shared database node at the bottom.

**Leaky Abstractions**
When implementation details of one layer bleed into another — database column names in the UI,
HTTP status codes in the domain model. Hard to see in overview diagrams but visible in
sequence diagrams where internal details appear in cross-layer messages.

### How the Diagrams Guide Better Code

When you generate or update `ARCHITECTURE.md`, you are implicitly reviewing the architecture.
If the diagram looks messy, consider:

1. **Before diagramming a messy area**: Could the code be restructured so the diagram is cleaner?
   If you're implementing a feature and you see the diagram getting tangled, that's a signal to
   refactor before proceeding.

2. **Design-first diagramming**: When building something new, sketch the architecture diagram
   *before* writing code. Add the new modules to `ARCHITECTURE.md`, see how they fit with
   existing structure, then implement. If the planned addition makes the diagram ugly, redesign.

3. **The readability test**: If you can't diagram a system cleanly with ~20 nodes and clear
   directional flow, the system is too complex or too coupled. The diagram is fighting you
   because the architecture is fighting itself.

4. **Refactoring validation**: After refactoring, regenerate the affected diagrams. The
   improvement should be visually obvious — fewer crossing edges, cleaner subgraph boundaries,
   more consistent flow direction.

---

## When This Skill Activates

### Initial Generation (first run)
The user asks to generate architecture diagrams for their codebase. There is no existing
`ARCHITECTURE.md`, or the user explicitly asks for a fresh scan.

### Update Cycle (subsequent runs)
The user has made code changes and wants the diagrams updated. Or you've just finished
implementing a feature and need to reflect structural changes. The skill diffs what changed
and surgically updates only the affected diagrams.

### On Every Code Change (discipline)
After making any structural change to a codebase (new module, new API route, new database table,
changed service dependencies), update `ARCHITECTURE.md` before finishing the task. This is not
optional — stale diagrams are worse than no diagrams.

---

## Scanning Strategy

### What to Scan (And How)

Analyze the codebase by reading its structure and tracing **actual dependencies**. Do not guess the architecture based on folder names (e.g. guessing that `pages` talks to `components`). **You must trace the actual code imports/requires.** Prioritize in this order:

1. **Directory structure** — `list_dir` recursively to understand module boundaries
2. **Package manifests** — `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `pom.xml`, etc.
3. **Entry points** — `main.*`, `index.*`, `app.*`, `server.*`
4. **Route definitions** — API routes, page routes, middleware chains
5. **Configuration** — `nuxt.config.*`, `next.config.*`, `wrangler.*`, `docker-compose.*`, `.env.example`
6. **Database schemas** — migration files, schema definitions, ORM models, Prisma/Drizzle schemas
7. **Service layer** — files in `services/`, `repositories/`, `composables/`, `hooks/`, `lib/`
8. **Type definitions** — `types/`, `interfaces/`, shared schemas
9. **Infrastructure** — Dockerfiles, CI/CD configs, deployment manifests

### What NOT to Scan

- Individual component implementation details (internal logic of a single function)
- Test files (unless they reveal architectural patterns)
- Generated files (`node_modules`, `dist`, `.next`, `.nuxt`, `.output`)
- Asset files (images, fonts, static content)

### Scanning for Large Codebases

For codebases with more than ~50 significant files or multiple packages/services:

1. Start with the top two directory levels only.
2. Identify **domain boundaries** (each package, service, or major feature area).
3. Scan each domain independently. Use `grep_search` to find actual import statements and service injections.
4. **CRITICAL**: Do NOT generate a diagram with generic layer names (e.g. "Presentation Layer", "Business Logic"). You must use the **concrete names** of the actual primary services, stores, and components discovered in the code.
5. Build the overview diagram from domain summaries, not from individual files.
6. Create per-domain detail diagrams only for domains with meaningful internal structure.

---

## Diagram Types

Generate only the diagram types that are **relevant** to what the codebase actually contains.
Do not force a diagram type that has no meaningful content. A small CLI tool does not need
a sequence diagram. A static site does not need an ER diagram.

### 1. System Overview (always include)

The bird's-eye view. Shows all major modules/services and their relationships.

Use `graph TD` (top-down) for hierarchical systems, `graph LR` (left-right) for pipeline/flow systems.

```
graph TD
    subgraph Client
        WebApp[Web Application]
        MobileApp[Mobile App]
    end
    
    subgraph API Layer
        Gateway[API Gateway]
        Auth[Auth Service]
    end
    
    subgraph Core Services
        UserSvc[User Service]
        OrderSvc[Order Service]
        NotifSvc[Notification Service]
    end
    
    subgraph Data
        PostgreSQL[(PostgreSQL)]
        Redis[(Redis Cache)]
        S3[(S3 Storage)]
    end
    
    WebApp --> Gateway
    MobileApp --> Gateway
    Gateway --> Auth
    Gateway --> UserSvc
    Gateway --> OrderSvc
    UserSvc --> PostgreSQL
    OrderSvc --> PostgreSQL
    OrderSvc --> NotifSvc
    NotifSvc --> Redis
    UserSvc --> S3
```

**Nodes shape conventions:**
- `[Rectangle]` — application / service
- `[(Database)]` — data store
- `([Stadium])` — external service / third-party
- `{Diamond}` — decision / router
- `((Circle))` — event / message

### 2. Component Diagram (when the system has distinct layers or modules)

Shows internal structure of a service or application — how packages, layers, and modules
connect within a single deployable unit.

```
graph TD
    subgraph Presentation
        Pages[Pages / Views]
        Components[UI Components]
        Layouts[Layouts]
    end
    
    subgraph Logic
        Composables[Composables]
        Store[State Management]
        Middleware[Middleware]
    end
    
    subgraph Data Access
        Services[Service Layer]
        Repositories[Repositories]
        API[API Client]
    end
    
    Pages --> Components
    Pages --> Composables
    Pages --> Store
    Composables --> Services
    Store --> Services
    Services --> Repositories
    Services --> API
    Middleware --> Store
```

### 3. Data Flow Diagram (when there are clear data pipelines)

Traces how **actual data payloads** enter, mutate, and exit the system. This is NOT just a component diagram laid out left-to-right. It must show **runtime data movement**.
- Label edges with the *actual data being passed* (e.g., `|JSON Payload|`, `|AuthToken|`, `|User Record|`).
- Show state mutations (e.g., how a Pinia store gets updated, or how an event triggers a database write).
- Identify concrete event topics, WebSockets, or queue names if they exist.

```
graph LR
    Request([HTTP POST /api/checkout]) -->|CheckoutPayload| Validator{Zod Schema}
    Validator -->|Valid Data| CheckoutSvc[checkout.service.ts]
    Validator -->|Invalid| Error([400 Bad Request])
    CheckoutSvc -->|Stripe Token| PaymentClient[stripe.client.ts]
    PaymentClient -->|PaymentSuccess| CheckoutSvc
    CheckoutSvc -->|Order Record| DB[(PostgreSQL: orders)]
    CheckoutSvc -->|order.created| EventBus{Kafka}
    EventBus -->|SendEmail| NotifSvc[notification.worker.ts]
```

### 4. Entity-Relationship Diagram (when there's a database)

Maps database tables, their columns, and relationships. Use Mermaid's `erDiagram` syntax.

```
erDiagram
    USER ||--o{ PROJECT : owns
    USER {
        uuid id PK
        string email
        string name
        timestamp created_at
    }
    PROJECT ||--|{ TASK : contains
    PROJECT {
        uuid id PK
        uuid user_id FK
        string title
        enum status
    }
    TASK {
        uuid id PK
        uuid project_id FK
        string title
        boolean completed
        timestamp due_date
    }
```

### 5. Sequence Diagram (when there are important multi-step flows)

Captures the **step-by-step runtime execution** of critical user journeys or system processes.
You must trace the actual function calls, API requests, and database queries that happen at runtime.
- Use actual route paths (e.g., `POST /api/auth/login`).
- Use actual function/method names (e.g., `verifyCredentials()`).
- Show the exact data being returned at each step.

```
sequenceDiagram
    participant U as User Client
    participant API as /api/auth (AuthHandler)
    participant Svc as AuthService
    participant DB as Users Table
    
    U->>API: POST /api/auth/login {email, pass}
    API->>Svc: validateUser(email, pass)
    Svc->>DB: SELECT * FROM users WHERE email = ?
    DB-->>Svc: User Record + Hash
    Svc->>Svc: bcrypt.compare()
    Svc-->>API: JWT Token
    API-->>U: 200 OK + Set-Cookie: token
```

### 6. Class / Interface Diagram (for OOP or strongly-typed codebases)

Shows type hierarchies, interfaces, and their relationships. Use Mermaid's `classDiagram` syntax.
Only include this when the codebase has meaningful type hierarchies — not for every TypeScript interface.

```
classDiagram
    class BaseService {
        <<abstract>>
        +logger: Logger
        +validate(input)
        +handleError(error)
    }
    class UserService {
        +getUser(id)
        +createUser(data)
        +updateUser(id, data)
    }
    class ProjectService {
        +getProject(id)
        +listProjects(userId)
        +createProject(data)
    }
    BaseService <|-- UserService
    BaseService <|-- ProjectService
    UserService --> UserRepository
    ProjectService --> ProjectRepository
```

---

## Output File Format

The output file is `ARCHITECTURE.md` at the project root (unless the user specifies otherwise).

### Structure Rules

1. **Title**: A single `#` heading with just the project name
2. **Table of Contents**: A Mermaid `graph LR` diagram that acts as a visual map of what diagrams exist
   (this is itself a diagram — no text TOC)
3. **Diagrams**: Each diagram gets:
   - An HTML comment: `<!-- diagram:diagram-type:scope -->`
   - A `##` heading (just the diagram name — e.g., `## System Overview`)
   - The Mermaid code block
4. **No text paragraphs, bullet lists, or explanations between diagrams**
5. **No "generated by" footers or timestamps** — the file is version-controlled, that's what git is for

### Example Output Structure

```markdown
# MyProject

## Navigation

` ` `mermaid
graph LR
    SO[System Overview] --> CD[Component Diagram]
    SO --> DF[Data Flow]
    CD --> ER[Database Schema]
    DF --> SD[Auth Sequence]
` ` `

<!-- diagram:overview:system -->
## System Overview

` ` `mermaid
graph TD
    ...
` ` `

<!-- diagram:component:app -->
## App Components

` ` `mermaid
graph TD
    ...
` ` `

<!-- diagram:dataflow:request -->
## Request Data Flow

` ` `mermaid
graph LR
    ...
` ` `

<!-- diagram:er:database -->
## Database Schema

` ` `mermaid
erDiagram
    ...
` ` `

<!-- diagram:sequence:auth -->
## Auth Flow

` ` `mermaid
sequenceDiagram
    ...
` ` `
```

---

## Update Cycle

When updating an existing `ARCHITECTURE.md`:

### Step 1: Read the existing file
Parse the current `ARCHITECTURE.md` and identify each diagram by its HTML comment marker.

### Step 2: Identify what changed
Determine what structural changes occurred since the last update:
- New files, directories, or modules added
- Files moved or renamed
- New dependencies or integrations
- Changed API routes or database schemas
- Removed modules or services

If you just made the changes yourself, you already know what changed.
If the user is asking for an update, scan for changes by comparing the diagrams against reality.

### Step 3: Surgical update
Update **only the diagrams affected by the changes**. Do not regenerate diagrams that haven't changed.
This is important for large systems — a full regeneration is wasteful and can introduce unnecessary diffs.

### Step 4: Validate consistency
After updating, quickly verify that:
- No diagram references a module that no longer exists
- New modules appear in the overview diagram
- Cross-references between diagrams are consistent (e.g., a service in the component diagram
  also appears in the data flow diagram if it handles data)

### Step 5: Write the updated file
Use the edit tools to update only the changed sections of `ARCHITECTURE.md`.
Do not rewrite the entire file.

---

## Depth Decision Logic

The skill automatically determines how deep to diagram based on codebase characteristics:

### Small codebase (< 15 significant files)
- System Overview (1 diagram)
- If there's a database: ER diagram
- Total: 1-2 diagrams

### Medium codebase (15-50 significant files)
- System Overview
- Component Diagram (1 per distinct layer)
- Data Flow (if there's an API or pipeline)
- ER Diagram (if there's a database)
- Total: 3-5 diagrams

### Large codebase (50-200 significant files)
- System Overview (high-level, showing domain boundaries)
- Component Diagram per domain/package
- Data Flow for major pipelines
- ER Diagram
- Sequence diagrams for 2-3 critical flows
- Total: 6-10 diagrams

### Very large / monorepo (200+ significant files)
- System Overview (services/packages only)
- Per-service component diagrams (only for services with meaningful internal structure)
- Cross-service data flow
- ER Diagram per database
- Sequence diagrams for the 3-5 most critical cross-service flows
- Total: 8-15 diagrams
- Consider splitting into `ARCHITECTURE.md` (overview) and `docs/arch/<service>.md` per service

**"Significant files"** = source code files excluding tests, configs, and generated files.

---

## Mermaid Best Practices

### Keep diagrams readable
- Maximum ~20 nodes per diagram. If it's bigger, split into sub-diagrams.
- Use meaningful short labels, not full file paths
- Group related nodes in `subgraph` blocks
- Use consistent node shapes (see conventions above)

### Avoid Mermaid syntax pitfalls
- Quote labels containing special characters: `id["Label (with parens)"]`
- Avoid HTML in labels
- Use `---` for strong connections, `-.->` for weak/optional connections
- Use `-->|label|` for labeled edges, keep labels under 4 words

### Color and styling (use sparingly)
Only use styling to distinguish fundamentally different types of components:
```
classDef service fill:#1a1a2e,stroke:#16213e,color:#e2e8f0
classDef database fill:#0f3460,stroke:#16213e,color:#e2e8f0
classDef external fill:#533483,stroke:#16213e,color:#e2e8f0
```

Do not over-style. The diagram's structure should communicate, not its colors.

---

## Anti-Patterns

**Do not:**
- **Create Generic Framework Diagrams**: This is the worst offense. Never draw a diagram that just shows generic boxes like "Pages -> Components -> State -> API -> DB" unless those are the literal names of the modules. Diagram the *actual* system (e.g., `spatial-canvas.vue` -> `useSync()`, `AgentGateway` -> `EveCore`), not a textbook definition of the framework.
- Add text explanations, bullet points, or paragraphs between diagrams.
- Include implementation details (function bodies, variable names, logic).
- Diagram every single file — focus on architectural boundaries.
- Use diagrams as a substitute for code comments.
- Create diagrams that require scrolling horizontally.
- Add "last updated" timestamps — use version control.
- Include node_modules, build outputs, or generated code in diagrams.
- Force diagram types that don't fit (no ER diagram if there's no database).

---

## Multi-Project / Monorepo Handling

For monorepos or multi-service architectures:

1. **Root `ARCHITECTURE.md`**: Contains only the system-level overview showing all services/packages
   and their inter-dependencies
2. **Per-service `ARCHITECTURE.md`** (optional, for large services): Contains the internal
   component diagram, data flow, and ER diagram for that service
3. The root overview should link to per-service files via the navigation diagram

---

## Framework-Specific Scanning Hints

### Nuxt / Next.js
- Scan `pages/` or `app/` for route structure
- Scan `server/api/` or `api/` for API routes
- Scan `composables/` or `hooks/` for shared logic
- Scan `middleware/` for request pipeline
- Check for `stores/` (Pinia) or context providers

### Express / Fastify / Hono
- Scan route registrations in entry point
- Follow middleware chains
- Map controller → service → repository layers

### Django / Rails / Laravel
- Scan models for ER diagram
- Scan URL configs / routes for API surface
- Map MVC / MTV layers

### Go / Rust / Java
- Scan package/module structure
- Map interface hierarchies
- Follow dependency injection patterns

---

## Quick Reference

| Step | Action |
|---|---|
| First run | Full scan → generate `ARCHITECTURE.md` |
| After code change | Identify changed modules → update affected diagrams only |
| User asks "update arch" | Re-scan → diff → surgical update |
| User asks "refresh diagrams" | Full re-scan → regenerate all |
| New service added | Add to overview + create service detail diagrams |
| Service removed | Remove from all diagrams where it appeared |
| DB schema changed | Update ER diagram |
| New API route | Update data flow diagram |

---

## Visual Conventions for Architectural Quality

Use these styling conventions consistently across all diagrams so that quality signals are
immediately recognizable. A developer should be able to glance at any diagram and instantly
see what's clean and what needs attention.

| Visual | Meaning | Mermaid Syntax |
|---|---|---|
| Solid arrow `-->` | Normal, healthy dependency | `A --> B` |
| Dashed arrow `-.->` | Weak / optional dependency | `A -.-> B` |
| Red dashed arrow | Circular dependency or coupling violation | `linkStyle N stroke:#e74c3c,stroke-dasharray:5` |
| Thick arrow | Critical path / high traffic | `A ==> B` |
| Subgraph with clean boundary | Well-isolated domain | `subgraph Domain ... end` |
| Node with 8+ connections | God module — needs decomposition | Show all connections, let density speak |
| Arrow skipping layers | Missing abstraction | Long vertical arrow in `graph TD` |
| `classDef` styles | Distinguish component types (not quality) | See styling section above |

---

## Reference Material

When you need mental models of what clean systems look like, or a workflow for designing before coding, read:
- **`references/architectures.md`** — Contains canonical Mermaid examples of Layered, Microservices, and Event-Driven architectures, plus the Design-First workflow guide.


---

## The Feedback Loop

The cycle that makes this skill powerful is:

```
Scan Code → Generate Diagrams → See Reality → Improve Code → Update Diagrams → See Improvement
```

Each revolution through this loop makes the system better. The diagrams are not just documentation —
they are a **design tool**, a **review tool**, and a **quality signal** rolled into one.

A codebase with a clean, up-to-date `ARCHITECTURE.md` is a codebase that someone thought carefully
about. The discipline of keeping diagrams current forces architectural awareness into every
code change.

