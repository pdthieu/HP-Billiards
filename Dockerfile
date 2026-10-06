# Build the server with the client embedded, then ship only the binary.
FROM golang:1.23-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/server ./cmd/server

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/server /server
# Listens on :8080, or on :$PORT when the platform sets PORT.
EXPOSE 8080
ENTRYPOINT ["/server"]
