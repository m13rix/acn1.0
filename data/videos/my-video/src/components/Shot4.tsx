import {
	AbsoluteFill,
	interpolate,
	useCurrentFrame,
	useVideoConfig,
	Img,
	staticFile,
	Audio,
	Easing,
} from 'remotion';
import React from 'react';

export const Shot4: React.FC = () => {
	const frame = useCurrentFrame();
	const {durationInFrames} = useVideoConfig();

	// Durations based on 8.69s total
	// Proportionally scaling 10s/15s to 8.69s
	// Passport: ~5.79s, Calendar: ~2.9s
	const passportDuration = Math.round((10 / 15) * durationInFrames);
	
	const isPassport = frame < passportDuration;

	// Ken Burns Effect for Passport
	const passportScale = interpolate(frame, [0, passportDuration], [1.1, 1.3], {
		extrapolateRight: 'clamp',
		easing: Easing.out(Easing.quad),
	});
	const passportX = interpolate(frame, [0, passportDuration], [0, -20], {
		extrapolateRight: 'clamp',
	});

	// Calendar Animation
	const calendarFrame = frame - passportDuration;
	const calendarDuration = durationInFrames - passportDuration;

	// Dramatic entrance (simulate "stopping")
	const calendarBlur = interpolate(calendarFrame, [0, 10], [10, 0], {
		extrapolateRight: 'clamp',
	});
	const calendarScale = interpolate(calendarFrame, [0, 10], [1.5, 1], {
		extrapolateRight: 'clamp',
		easing: Easing.out(Easing.back(1.5)),
	});

	// Glow effect for "freeze frame" (towards the end)
	const freezeFrameStart = calendarDuration - 20;
	const glow = interpolate(calendarFrame, [freezeFrameStart, calendarDuration], [0, 20], {
		extrapolateLeft: 'clamp',
	});

	// Text Overlay
	const textOpacity = interpolate(calendarFrame, [10, 20], [0, 1], {
		extrapolateLeft: 'clamp',
		extrapolateRight: 'clamp',
	});

	return (
		<AbsoluteFill style={{backgroundColor: 'black'}}>
			{isPassport ? (
				<AbsoluteFill
					style={{
						transform: `scale(${passportScale}) translateX(${passportX}px)`,
					}}
				>
					<Img
						src={staticFile('soviet_passport.png')}
						style={{
							width: '100%',
							height: '100%',
							objectFit: 'cover',
						}}
					/>
				</AbsoluteFill>
			) : (
				<AbsoluteFill>
					<AbsoluteFill
						style={{
							transform: `scale(${calendarScale})`,
							filter: `blur(${calendarBlur}px) drop-shadow(0 0 ${glow}px gold)`,
						}}
					>
						<Img
							src={staticFile('calendar_eighteen.png')}
							style={{
								width: '100%',
								height: '100%',
								objectFit: 'cover',
							}}
						/>
					</AbsoluteFill>

					{/* Overlay Text */}
					<AbsoluteFill
						className="justify-center items-center"
						style={{opacity: textOpacity}}
					>
						<h1
							className="text-white text-9xl font-bold text-center uppercase drop-shadow-2xl"
							style={{
								fontFamily: 'Inter, sans-serif',
								textShadow: '0 0 20px rgba(0,0,0,0.8)',
							}}
						>
							восемнадцать лет
						</h1>
					</AbsoluteFill>
				</AbsoluteFill>
			)}

			<Audio src={staticFile('shot4_voice.mp3')} />
		</AbsoluteFill>
	);
};
