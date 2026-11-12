# The model gateway of the test: LiteLLM at the release that the ops
# repository runs, with an Anthropic entry whose api_base is the bridge.
# Test only, never pushed.
FROM ghcr.io/berriai/litellm:v1.109.0@sha256:26aecfb02fb17ac6590f0549478561f9fbb3f69314317320b2e32a21beed4006
COPY config.yaml /config/config.yaml
ENV LITELLM_TELEMETRY=False
