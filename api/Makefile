# Run from api/. `make up` starts Postgres, NATS and the monolith in Docker; `make run` runs the
# monolith from source against the compose Postgres.
SHELL := /bin/bash

POSTGRES_PORT ?= 55432
API_PORT ?= 8080
DATABASE_URL ?= postgres://wit:wit@localhost:$(POSTGRES_PORT)/wit?sslmode=disable
JWT_SECRET ?= dev-only-secret-change-me-0123456789abcdef
LOCAL_ENV = DATABASE_URL='$(DATABASE_URL)' JWT_SECRET='$(JWT_SECRET)' DEMO_MODE=true MIGRATE_ON_START=true HTTP_ADDR=:$(API_PORT)

.PHONY: up db down split-up migrate seed run test lint contract export-fixtures wiring

up: ## Postgres, NATS and the monolith in Docker
	API_PORT=$(API_PORT) POSTGRES_PORT=$(POSTGRES_PORT) docker compose up -d --build --wait postgres nats monolith

db: ## Postgres and NATS only, for tests and `make run`
	POSTGRES_PORT=$(POSTGRES_PORT) docker compose up -d --wait postgres nats

split-up: ## identity, property, channel, guest, reservation, billing, services, people, payroll, maintenance, inventory, owners, files, relay and gateway on NATS; gateway on :8090
	POSTGRES_PORT=$(POSTGRES_PORT) docker compose --profile split up -d --build --scale monolith=0

down:
	docker compose --profile split down

migrate:
	$(LOCAL_ENV) go run ./cmd/migrate

seed:
	$(LOCAL_ENV) go run ./cmd/seed

run:
	$(LOCAL_ENV) go run ./cmd/monolith

test: ## integration tests need `make db`; without Postgres they skip
	TEST_DATABASE_URL='$(DATABASE_URL)' go test -timeout 30m ./...

lint:
	go vet ./...
	@if command -v staticcheck >/dev/null 2>&1; then staticcheck ./...; else echo "staticcheck not installed; go vet only"; fi

contract: ## implemented vs missing contract calls per owning context
	node scripts/contract.mjs

export-fixtures: ## refresh seed/*.json and the rbac snapshot from the TypeScript sources
	node scripts/export-seed.mjs
	node scripts/export-permissions.mjs

wiring: ## log in and read the property catalog the way the front end does (needs `make run` or `make up`)
	node scripts/wiring-check.mjs http://localhost:$(API_PORT)/api/v1
