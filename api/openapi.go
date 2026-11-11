// Package api embeds the OpenAPI document served at /api/v1/docs/openapi.yaml.
package api

import _ "embed"

// OpenAPI is openapi.yaml, the hand-written description of the routes this module serves.
//
//go:embed openapi.yaml
var OpenAPI []byte
