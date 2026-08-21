# Separate Task Types from Providers

Task Types own reusable workflow semantics and ordered implementer/reviewer Stages, while Providers own model, transport, capability, and provider-specific safety behavior. Each Stage pins exactly one Provider in user configuration: Sol may select a Task Type but cannot choose among Providers or silently fall back, preserving explicit user control and preventing model-specific task duplication.
