.PHONY: run build test e2e e2e-deps

run: ## start the server on :8080
	go run ./cmd/server -addr :8080

build: ## build the server binary into bin/
	go build -o bin/server ./cmd/server

test: ## format check, vet and unit tests
	@test -z "$$(gofmt -l .)" || { echo "gofmt needed:"; gofmt -l .; exit 1; }
	go vet ./...
	go test -race ./...

e2e: ## browser tests against a freshly built server (needs e2e-deps once)
	cd e2e && node run.js

e2e-deps: ## install Playwright and a Chromium for the browser tests
	cd e2e && npm install && npx playwright install chromium
