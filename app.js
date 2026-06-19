
}

function wireAuth() {
  document.getElementById("loginForm").addEventListener("submit", async (event) => {
  const loginForm = document.getElementById("loginForm");
  const loginSubmit = document.getElementById("loginSubmit");
  const handleLogin = async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const form = loginForm;
    const data = formData(form);
    setLoginLoading(true);
    showLoginError("");
    }
    form.reset();
    showToast("Signed in.");
  });
  };

  loginForm.addEventListener("submit", handleLogin);
  loginSubmit.addEventListener("click", handleLogin);

  document.getElementById("signOutButton").addEventListener("click", async () => {
    await supabaseClient.auth.signOut();
