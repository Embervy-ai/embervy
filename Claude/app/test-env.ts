// Tests must not load house translations; explicit translation fixtures keep their own path.
process.env.EMBERVY_STRINGS_LOCAL ??= `${import.meta.path}/absent.json`;
