import { Route } from '@/routes/channels_/$channelId/programming/index.tsx';
import {
  Add as AddIcon,
  AddToQueue,
  Directions as RedirectIcon,
  Expand as FlexIcon,
  KeyboardArrowDown as KeyboardArrowDownIcon,
  AutoAwesome,
} from '@mui/icons-material';
import { Button, MenuItem } from '@mui/material';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useChannelEditor } from '../../store/selectors.ts';
import { ElevatedTooltip } from '../base/ElevatedTooltip.tsx';
import { StyledMenu } from '../base/StyledMenu';
import AddFlexModal from '../programming_controls/AddFlexModal';
import AddRedirectModal from '../programming_controls/AddRedirectModal';
import { SeedChannelDialog } from '../programming_controls/SeedChannelDialog.tsx';

export default function AddProgrammingButton() {
  const { t } = useLingui();
  const { seedGrowth } = useChannelEditor();
  const [addRedirectModalOpen, setAddRedirectModalOpen] = useState(false);
  const [addFlexModalOpen, setAddFlexModalOpen] = useState(false);
  const [seedChannelOpen, setSeedChannelOpen] = useState(false);
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const navigate = useNavigate();
  const { channelId } = Route.useParams();

  const open = anchorEl !== null;

  const handleClose = () => {
    setAnchorEl(null);
  };

  const addProgrammingOptions = [
    {
      icon: <AutoAwesome />,
      name: t`Generate from seeds...`,
      callback: () => setSeedChannelOpen(true),
      description: t`Build a channel from related programs and this channel's recorded plays.`,
    },
    {
      icon: <AddToQueue />,
      name: t`Media...`,
      callback: () =>
        navigate({
          to: '/channels/$channelId/programming/add',
          params: { channelId },
        }),
      description: t`Add TV Shows or Movies to programming list.`,
    },
    {
      icon: <RedirectIcon />,
      name: t`Redirect...`,
      callback: () => setAddRedirectModalOpen(true),
      description: t`Adds a channel redirect. During this period of time, the channel will redirect to another channel.`,
    },
    {
      icon: <FlexIcon />,
      name: t`Flex Slot...`,
      callback: () => setAddFlexModalOpen(true),
      description: t`Adds one Flex time slot. To add Flex across the whole lineup at once, use the Flex menu next to Add.`,
    },
  ];

  return (
    <>
      <SeedChannelDialog
        open={seedChannelOpen}
        onClose={() => setSeedChannelOpen(false)}
      />
      <AddFlexModal
        open={addFlexModalOpen}
        onClose={() => setAddFlexModalOpen(false)}
      />
      <AddRedirectModal
        open={addRedirectModalOpen}
        onClose={() => setAddRedirectModalOpen(false)}
      />

      <Button
        startIcon={<AutoAwesome />}
        onClick={() => setSeedChannelOpen(true)}
        variant="outlined"
      >
        {seedGrowth?.rolling
          ? t`Auto-generation: Rolling guide`
          : seedGrowth
            ? t`Auto-generation: Grow when watched`
            : t`Auto-generation: Off`}
      </Button>
      <Button
        id="channel-programming-add-button"
        startIcon={<AddIcon />}
        endIcon={<KeyboardArrowDownIcon />}
        onClick={(event) => setAnchorEl(event.currentTarget)}
        variant="outlined"
      >
        <Trans>Add</Trans>
      </Button>
      <StyledMenu
        id="channel-programming-add"
        MenuListProps={{
          'aria-labelledby': 'channel-programming-add-button',
        }}
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
      >
        {addProgrammingOptions.map((item) => (
          <ElevatedTooltip
            elevation={10}
            key={item.name}
            title={item.description}
            placement="right"
          >
            <MenuItem
              disableRipple
              onClick={() => {
                item.callback();
                handleClose();
              }}
            >
              {item.icon} {item.name}
            </MenuItem>
          </ElevatedTooltip>
        ))}
      </StyledMenu>
    </>
  );
}
