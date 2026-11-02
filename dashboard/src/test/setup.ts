import { setLocaleSilently } from "@/i18n/core";

// Tests assert English strings; never depend on the machine's language.
setLocaleSilently("en");
