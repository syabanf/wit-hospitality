# One image holds every command; compose picks the binary per service.
FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN mkdir -p /out && CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/ ./cmd/...

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ /app/
ENV HTTP_ADDR=:8080
EXPOSE 8080
USER nonroot
CMD ["/app/monolith"]
