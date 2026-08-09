# Architectural Patterns and References

This reference document contains canonical examples of what clean systems look like when diagrammed, and common architectural patterns. Use these as mental models when scanning a codebase and deciding how to represent it.

## Recognizing Architectural Patterns

When scanning, identify which pattern the codebase follows (or should follow):

| Pattern | Structure | Best For |
|---|---|---|
| **Layered (N-tier)** | Horizontal layers: Presentation → Business → Data | Traditional web apps, CRUD APIs |
| **Hexagonal (Ports & Adapters)** | Core domain at center, adapters at edges | Domain-heavy apps, many integrations |
| **Event-Driven** | Producers → Event Bus → Consumers | Real-time systems, decoupled services |
| **Microservices** | Independent services with own data stores | Large teams, independent deployments |
| **Modular Monolith** | Single deployment, strict module boundaries | Growing apps not yet ready to split |
| **Pipeline** | Stage → Stage → Stage (linear data flow) | ETL, build systems, data processing |
| **CQRS** | Separate read/write paths | High-read or complex query systems |

Diagram each pattern using the topology that makes it most readable:
- Layered → `graph TD` (top-down layers)
- Hexagonal → `graph TD` with core in center subgraph
- Event-Driven → `graph LR` (flow left to right through event bus)
- Microservices → `graph TD` with each service as a subgraph
- Pipeline → `graph LR` (linear flow)

## Reference Architectures

These are canonical examples of what clean systems look like when diagrammed. Use them as mental models when scanning a codebase — compare what you see against these shapes.

### Clean Layered Architecture (Nuxt / Next.js Full-Stack App)

```
graph TD
    subgraph Presentation
        Pages[Pages]
        Components[Components]
        Layouts[Layouts]
    end

    subgraph Application Logic
        Composables[Composables]
        Middleware[Middleware]
        Store[State Store]
    end

    subgraph Domain
        Services[Services]
        Validators[Validators]
    end

    subgraph Infrastructure
        Repositories[Repositories]
        APIRoutes[API Routes]
        DB[(Database)]
        External([External APIs])
    end

    Pages --> Components
    Pages --> Composables
    Pages --> Store
    Composables --> Services
    Middleware --> Store
    Services --> Validators
    Services --> Repositories
    APIRoutes --> Services
    Repositories --> DB
    Services --> External
```

Notice: arrows only flow downward. No layer reaches back up. Each subgraph is self-contained. That's the shape of clean architecture.

### Clean Microservices Architecture

```
graph TD
    Client([Client Apps]) --> Gateway[API Gateway]

    subgraph User Domain
        UserAPI[User API]
        UserDB[(User DB)]
        UserAPI --> UserDB
    end

    subgraph Order Domain
        OrderAPI[Order API]
        OrderDB[(Order DB)]
        OrderAPI --> OrderDB
    end

    subgraph Notification Domain
        NotifWorker[Notification Worker]
        NotifQueue[(Message Queue)]
    end

    Gateway --> UserAPI
    Gateway --> OrderAPI
    OrderAPI -->|events| NotifQueue
    NotifQueue --> NotifWorker
    UserAPI -.->|async lookup| OrderAPI
```

Notice: each service owns its own data store. Cross-service communication is minimal and mostly async (through the message queue). The dashed arrow shows the one place where services talk directly — a conscious trade-off, not an accident.

### Clean Event-Driven Architecture

```
graph LR
    Producer1[Order Service] -->|order.created| Bus{Event Bus}
    Producer2[Payment Service] -->|payment.completed| Bus
    Bus -->|order.created| Consumer1[Inventory Service]
    Bus -->|order.created| Consumer2[Email Service]
    Bus -->|payment.completed| Consumer3[Order Service]
    Bus -->|payment.completed| Consumer4[Analytics Service]

    Consumer1 --> InventoryDB[(Inventory DB)]
    Consumer4 --> AnalyticsDB[(Analytics DB)]
```

Notice: the event bus is the only coupling point. Services don't know about each other — they publish events and subscribe to events. Adding a new consumer doesn't change any existing service.

## Design-First Workflow

The most powerful use of this skill is **before writing code**. When planning a new feature or system:

### Step 1: Sketch the target architecture
Add the planned new modules/services to `ARCHITECTURE.md` as if they already exist. See how they fit with the current structure. Do the new arrows create clean flow or tangled mess?

### Step 2: Evaluate the diagram
Ask yourself:
- Does the dependency flow stay unidirectional?
- Do the new modules respect existing domain boundaries?
- Is any existing module becoming a god module by absorbing too much?
- Can you explain the diagram to someone in 30 seconds?

### Step 3: Refine before implementing
If the diagram looks wrong, redesign before writing a line of code. It's infinitely cheaper to move boxes in a diagram than to restructure a codebase.

### Step 4: Implement and verify
Build the feature following the planned architecture. After implementation, regenerate the diagrams and confirm reality matches the plan. If it diverged, either fix the code or update the plan — but never leave them out of sync.
