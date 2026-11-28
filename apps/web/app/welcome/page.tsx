import type { Metadata } from "next";
import { LandingPage } from "../landing/LandingPage";

export const metadata: Metadata = {
  title: "Nova Context",
  description:
    "Human context infrastructure. You invoke it, say what the moment means, and keep it in an account you can export or delete.",
};

export default function WelcomePage() {
  return <LandingPage />;
}
