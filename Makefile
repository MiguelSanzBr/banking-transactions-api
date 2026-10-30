.PHONY: up down test lint

up:
	docker compose up --build

down:
	docker compose down

# Installs dependencies on a fresh clone (and again whenever package-lock.json changes).
node_modules: package-lock.json
	npm ci
	touch node_modules

test: node_modules
	npm test

lint: node_modules
	npm run lint
