# Model cost record

## Scope

Tandem has no model inference, training, or model-backed runtime feature.
The application, benchmark harnesses, and CI do not read `NVIDIA_API_KEY` or
`GEMINI_API_KEY`; neither key is present in this repository.

## Reproducible runtime estimate

| Period / workload                                           | Measured model tokens | Named provider list price | Estimate |
| ----------------------------------------------------------- | --------------------: | ------------------------: | -------: |
| All committed application, test, benchmark, and CI commands |                     0 |            Not applicable |    $0.00 |

The token count is zero because no committed command invokes a model provider.
This is a runtime/project cost record, not a reconstruction of any private
development-assistant usage. The repository has no token telemetry for such
usage, so assigning a provider price or an estimate to it would be invented.

## If model-backed work is added

Record the provider, model, public list-price URL and retrieval date, measured
input/output tokens, and the calculation `input tokens × input price + output
tokens × output price`. Store the raw usage export or a redacted machine-
readable record alongside the result; do not log credentials.
