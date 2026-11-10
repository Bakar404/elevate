import { cookies } from "next/headers";
import { LogoPicker } from "@/components/logo-picker";
import { DEFAULT_LOGO, isLogoVariant, LOGO_COOKIE } from "@/lib/prefs";

export const dynamic = "force-dynamic";

export default async function BrandPage() {
  const v = (await cookies()).get(LOGO_COOKIE)?.value;
  return (
    <div className="mx-auto max-w-5xl px-8 py-10">
      <h1 className="text-2xl font-semibold tracking-tight">Logo drafts</h1>
      <p className="mt-1 max-w-xl text-sm text-muted">
        Five directions for the mark next to “elevate”. Each uses the app's sky → olive gradient. Pick one to try it in the sidebar and on the home map; you can switch back any time.
      </p>
      <div className="mt-8">
        <LogoPicker current={isLogoVariant(v) ? v : DEFAULT_LOGO} />
      </div>
    </div>
  );
}
