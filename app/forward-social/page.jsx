import { redirect } from "next/navigation";

export default function Page() {
  redirect("/distribution?view=automation&contentType=agent-sync");
}
