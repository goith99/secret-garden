pub mod claim_starters;
pub mod close_pot_vault;
pub mod close_round;
pub mod create_profile;
pub mod distribute_pot;
pub mod finalize_round;
pub mod initialize_config;
pub mod open_round;
pub mod release_flower;
pub mod set_mutant_weight;
pub mod set_sgd_mint;
pub mod set_paused;
pub mod submit_entry;

// Glob re-export so the `#[program]` macro can resolve each instruction's generated
// `__client_accounts_*` helper modules at the crate root. The `handler` functions are
// `pub(crate)` (not `pub`), so they are not pulled in here and cannot collide.
pub use claim_starters::*;
pub use close_pot_vault::*;
pub use close_round::*;
pub use create_profile::*;
pub use distribute_pot::*;
pub use finalize_round::*;
pub use initialize_config::*;
pub use open_round::*;
pub use release_flower::*;
pub use set_mutant_weight::*;
pub use set_sgd_mint::*;
pub use set_paused::*;
pub use submit_entry::*;
