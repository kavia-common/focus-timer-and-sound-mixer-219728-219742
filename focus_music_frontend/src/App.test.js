import { render, screen } from "@testing-library/react";
import App from "./App";

test("renders Focus // Mixer header", () => {
  render(<App />);
  expect(screen.getByText(/Focus\s*\/\/\s*Mixer/i)).toBeInTheDocument();
});
