// Research-only reachability control. Not an OmniRoute management operation.
import { NextResponse } from "next/server";
export const dynamic = "force-dynamic";
export async function GET() { return NextResponse.json({ fixture: "management-handler-reached" }); }
