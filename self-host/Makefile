# ============================================================
# MCP Emails, self-host
# ============================================================
# Quick start:
#   make setup        # generate .env (secrets), run once
#   make up           # build + start the stack
#   make provision EMAIL=you@example.com IMAP_HOST=imap.example.com SMTP_HOST=smtp.example.com
#   make key          # mint an MCP API key
#
# Then point your MCP client at  http://localhost:8787  with
#   Authorization: Bearer <the key you minted>
# ============================================================

COMPOSE ?= docker compose
DENO_IMG ?= denoland/deno:2.1.4

.PHONY: help setup up down logs ps restart build provision key keys inboxes revoke dispatch psql destroy

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

setup: ## Generate .env with fresh secrets (refuses to overwrite an existing one)
	@if [ -f .env ]; then echo ".env already exists, delete it first to regenerate (this rotates ENCRYPTION_KEY and breaks stored creds)."; exit 1; fi
	@docker run --rm -v "$(PWD)/cli:/cli:ro" $(DENO_IMG) run --allow-net --allow-env /cli/mcpe.ts gen-secrets > .env
	@echo "✓ wrote .env  (review it; keep it private)"

build: ## Build the server image
	$(COMPOSE) build

up: ## Build and start the stack (add SCHEDULER=1 for the scheduled-send dispatcher)
	@if [ ! -f .env ]; then echo "no .env, run 'make setup' first"; exit 1; fi
ifdef SCHEDULER
	$(COMPOSE) --profile scheduler up -d --build
else
	$(COMPOSE) up -d --build
endif
	@echo "✓ MCP server on http://localhost:$${MCP_PORT:-8787}"

down: ## Stop the stack (keeps data)
	$(COMPOSE) --profile scheduler --profile tools down

restart: ## Restart services
	$(COMPOSE) restart

ps: ## Show service status
	$(COMPOSE) ps

logs: ## Tail logs (S=mcp-server to scope to one service)
	$(COMPOSE) logs -f $(S)

# ── provisioning (runs the CLI in a one-off container on the stack network) ──

provision: ## Connect an IMAP/SMTP inbox. Vars: EMAIL, IMAP_HOST, SMTP_HOST [IMAP_PORT, SMTP_PORT, USERNAME, SERVICE, IMAP_PASSWORD]
	@if [ -z "$(EMAIL)" ] || [ -z "$(IMAP_HOST)" ] || [ -z "$(SMTP_HOST)" ]; then \
	  echo "usage: make provision EMAIL=you@example.com IMAP_HOST=imap.example.com SMTP_HOST=smtp.example.com [IMAP_PORT=993 SMTP_PORT=465 USERNAME=.. SERVICE=generic]"; \
	  echo "password: set IMAP_PASSWORD env (export IMAP_PASSWORD=... ; make provision ...)"; exit 1; \
	fi
	$(COMPOSE) run --rm -e IMAP_PASSWORD cli provision-inbox \
	  --email "$(EMAIL)" --imap-host "$(IMAP_HOST)" --smtp-host "$(SMTP_HOST)" \
	  --imap-port "$${IMAP_PORT:-993}" --smtp-port "$${SMTP_PORT:-465}" \
	  $(if $(USERNAME),--username "$(USERNAME)",) \
	  $(if $(SERVICE),--service "$(SERVICE)",) \
	  $(if $(DISPLAY_NAME),--display-name "$(DISPLAY_NAME)",)

key: ## Mint an MCP API key. Vars: NAME, SCOPES (comma), INBOX (email/id), EXPIRES_DAYS
	$(COMPOSE) run --rm cli create-key \
	  $(if $(NAME),--name "$(NAME)",) \
	  $(if $(SCOPES),--scopes "$(SCOPES)",) \
	  $(if $(INBOX),--inbox "$(INBOX)",) \
	  $(if $(EXPIRES_DAYS),--expires-days "$(EXPIRES_DAYS)",)

keys: ## List active API keys
	$(COMPOSE) run --rm cli list-keys

inboxes: ## List connected inboxes
	$(COMPOSE) run --rm cli list-inboxes

revoke: ## Revoke an API key. Var: PREFIX
	@if [ -z "$(PREFIX)" ]; then echo "usage: make revoke PREFIX=mcpe_ab1"; exit 1; fi
	$(COMPOSE) run --rm cli revoke-key "$(PREFIX)"

dispatch: ## Manually flush due scheduled sends once
	@DISPATCH_SECRET=$$(grep '^DISPATCH_SECRET=' .env | cut -d= -f2); \
	$(COMPOSE) run --rm --no-deps --entrypoint sh dispatcher -c \
	  "curl -fsS -X POST -H 'X-Dispatch-Secret: $$DISPATCH_SECRET' http://mcp-server:8000/dispatch"

psql: ## Open a psql shell on the database
	$(COMPOSE) exec db psql -U postgres -d postgres

destroy: ## Stop the stack and DELETE all data (volumes)
	$(COMPOSE) --profile scheduler --profile tools down -v
